#!/usr/bin/env node
// preToolUse hook: runs BEFORE every tool the agent calls.
// Input (stdin): { sessionId, timestamp, cwd, toolName, toolArgs }
// Output (stdout): nothing to allow, or { permissionDecision: "deny", ... } to block.
// It does not depend on the model "wanting" to comply: it is deterministic code.
// It is a deny list, not a sandbox: it knows the usual spellings of each command, not every possible one.

import { appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const AUDIT_LOG = path.join(os.tmpdir(), "copilot-talk-audit.log");

const PROTECTED_PATHS = [/(^|\/)\.github\/workflows(\/|$)/, /(^|\/)LICENSE(\.[A-Za-z]+)?$/];
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
// Commands that modify every path they receive. cp only modifies its last argument.
const WRITERS = new Set(["tee", "touch", "truncate", "rm", "mv", "ln", "install"]);
// git options that take their value as a separate word, so it is not mistaken for the subcommand.
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

function readStdin() {
    return new Promise((resolve) => {
        let data = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => (data += chunk));
        process.stdin.on("end", () => resolve(data));
    });
}

function parseArgs(toolArgs) {
    let value = toolArgs;
    if (typeof value === "string") {
        try {
            value = JSON.parse(value);
        } catch {
            return { raw: toolArgs };
        }
    }
    if (typeof value === "string") return { raw: value };
    return value && typeof value === "object" ? value : {};
}

// Splits a shell command into simple commands, each one a list of words with the quotes removed.
// ; | & ( ) ` and newlines outside quotes end a command, so "cd x && rm -rf y" is two commands.
function simpleCommands(command) {
    const commands = [[]];
    let word = null;
    let quote = null;
    const endWord = () => {
        if (word !== null) commands.at(-1).push(word);
        word = null;
    };
    const endCommand = () => {
        endWord();
        if (commands.at(-1).length) commands.push([]);
    };
    for (let i = 0; i < command.length; i++) {
        const char = command[i];
        if (quote) {
            if (char === quote) quote = null;
            else if (char === "\\" && quote === '"' && i + 1 < command.length) word += command[++i];
            else word += char;
        } else if (char === '"' || char === "'") {
            quote = char;
            word ??= "";
        } else if (char === "\\" && i + 1 < command.length) {
            word = (word ?? "") + command[++i];
        } else if (char === "\n" || ";|&()`".includes(char)) {
            endCommand();
        } else if (/\s/.test(char)) {
            endWord();
        } else {
            word = (word ?? "") + char;
        }
    }
    endCommand();
    return commands.filter((words) => words.length);
}

function isProtected(word) {
    return PROTECTED_PATHS.some((rule) => rule.test(word.replaceAll("\\", "/")));
}

function protectedReason(target) {
    return `Protected path: ${target}. Ask a person to make this change.`;
}

// Options come before "--". Short flags can be grouped (-rf, -fr, -rfv) or split (-r -f).
function optionsOf(args) {
    const end = args.indexOf("--");
    return (end === -1 ? args : args.slice(0, end)).filter((word) => word.startsWith("-") && word !== "-");
}

function isRecursiveForceRm(args) {
    const options = optionsOf(args);
    const letters = options.filter((word) => !word.startsWith("--")).join("");
    const recursive = /[rR]/.test(letters) || options.includes("--recursive");
    const force = letters.includes("f") || options.includes("--force");
    return recursive && force;
}

function gitSubcommand(args) {
    for (let i = 0; i < args.length; i++) {
        if (GIT_OPTIONS_WITH_VALUE.has(args[i])) i++;
        else if (!args[i].startsWith("-")) return { name: args[i], args: args.slice(i + 1) };
    }
    return null;
}

// --force, --force-with-lease, -f (also grouped, as in -uf) and a "+" in front of a refspec all rewrite remote history.
function isForcePush(args) {
    return optionsOf(args).some((word) => /^--force(-with-lease|-if-includes)?(=.*)?$/.test(word) || /^-[A-Za-z]*f[A-Za-z]*$/.test(word))
        || args.some((word) => word.startsWith("+"));
}

function redirectTargets(words) {
    const targets = [];
    words.forEach((word, i) => {
        const match = /^\d*>>?(.*)$/.exec(word);
        if (match) targets.push(match[1] || words[i + 1]);
    });
    return targets.filter(Boolean);
}

function writtenPaths(name, args) {
    const operands = args.filter((word) => !word.startsWith("-"));
    if (WRITERS.has(name)) return operands;
    if (name === "cp") return operands.slice(-1);
    if (name === "sed" && args.some((word) => /^-[A-Za-z]*i/.test(word) || word.startsWith("--in-place"))) return operands;
    return [];
}

// bash -c "...", sh -c '...' and eval "..." run another command line: check that one too.
function nestedScript(name, args) {
    if (name === "eval") return args.join(" ");
    const flag = args.findIndex((word) => /^-[A-Za-z]*c$/.test(word));
    return flag === -1 ? null : (args[flag + 1] ?? null);
}

function checkCommand(command, depth = 0) {
    if (depth > 3) return null;
    for (const match of command.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
        const reason = checkCommand(match[1] ?? match[2], depth + 1);
        if (reason) return reason;
    }
    for (const words of simpleCommands(command)) {
        for (const target of redirectTargets(words)) {
            if (isProtected(target)) return protectedReason(target);
        }
        for (let i = 0; i < words.length; i++) {
            const name = path.basename(words[i]).replace(/\.exe$/i, "");
            const args = words.slice(i + 1);
            if (name === "rm" && isRecursiveForceRm(args)) return "Forced recursive delete (rm -rf).";
            if (name === "git") {
                const sub = gitSubcommand(args);
                if (sub?.name === "push" && isForcePush(sub.args)) return "git push --force is not allowed in this repo.";
                if (sub?.name === "reset" && sub.args.includes("--hard")) return "git reset --hard throws away uncommitted work.";
            }
            for (const target of writtenPaths(name, args)) {
                if (isProtected(target)) return protectedReason(target);
            }
            if (SHELLS.has(name) || name === "eval") {
                const script = nestedScript(name, args);
                const reason = script ? checkCommand(script, depth + 1) : null;
                if (reason) return reason;
            }
        }
    }
    return null;
}

function decide(toolName, args) {
    const command = args.command ?? args.raw ?? "";
    if (typeof command === "string") {
        const reason = checkCommand(command);
        if (reason) return reason;
    }
    const target = args.path ?? args.file_path ?? args.filePath ?? "";
    const writes = /^(edit|create|write|str_replace|apply_patch)/i.test(toolName ?? "");
    if (writes && typeof target === "string" && isProtected(target)) return protectedReason(target);
    return null;
}

const raw = await readStdin();
let input;
try {
    input = JSON.parse(raw || "{}");
} catch {
    process.exit(0); // Unreadable input: never block the session because the hook failed.
}
if (!input || typeof input !== "object") process.exit(0);

let reason = null;
try {
    reason = decide(input.toolName, parseArgs(input.toolArgs));
} catch (error) {
    console.error("[guard]", error); // A bug in the rules must not lock the session either.
}
const verdict = reason ? "DENY" : "allow";

await appendFile(AUDIT_LOG, `${new Date().toISOString()} ${verdict} ${input.toolName ?? "?"}\n`).catch(() => {});

if (reason) {
    process.stdout.write(JSON.stringify({ permissionDecision: "deny", permissionDecisionReason: reason }));
}
