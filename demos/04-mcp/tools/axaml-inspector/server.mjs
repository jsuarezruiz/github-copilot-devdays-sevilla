#!/usr/bin/env node
// axaml-inspector: a minimal MCP server (stdio, no dependencies).
// Gives the agent something it cannot see: which controls the AXAML views contain
// and which ones can be found by AutomationId.
//
// Protocol: JSON-RPC 2.0, one message per line on stdin/stdout.
// Golden rule: stdout is only for the protocol. Logs go to stderr.

import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

const ROOT = await realpath(process.cwd());
const SKIP = new Set(["bin", "obj", "node_modules", ".git", "_site"]);
const INTERACTIVE = new Set([
    "Button", "RepeatButton", "ToggleButton", "TextBox", "ComboBox", "CheckBox",
    "RadioButton", "Slider", "ToggleSwitch", "ListBox", "MenuItem", "NumericUpDown",
    "DatePicker", "AutoCompleteBox", "TabItem",
]);
const MAX_FILES = 200;

const TOOLS = [
    {
        name: "list_controls",
        description:
            "Lists the interactive controls in the AXAML views with their type, Name, AutomationId, file and line. " +
            `Scans at most ${MAX_FILES} files: if "truncated" is true, call it again with a narrower path.`,
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", description: "Folder or .axaml file relative to the repo. Defaults to the whole repo." },
            },
        },
    },
    {
        name: "find_missing_automation_ids",
        description:
            "Returns the interactive controls that have no AutomationProperties.AutomationId and suggests one " +
            "that is unique among the scanned files. " +
            `Scans at most ${MAX_FILES} files: if "truncated" is true, call it again with a narrower path.`,
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", description: "Folder or .axaml file relative to the repo. Defaults to the whole repo." },
            },
        },
    },
];

function isInside(candidate) {
    return candidate === ROOT || candidate.startsWith(ROOT + path.sep);
}

async function resolveInsideRoot(relative = ".") {
    if (typeof relative !== "string") throw new Error("path must be a string.");
    const target = path.resolve(ROOT, relative);
    if (!isInside(target)) throw new Error("The path must be inside the repository.");
    let real;
    try {
        real = await realpath(target);
    } catch {
        throw new Error(`Path not found: ${path.relative(ROOT, target) || "."}`);
    }
    // A symlink inside the repository must not lead outside of it.
    if (!isInside(real)) throw new Error("The path must be inside the repository.");
    return real;
}

async function axamlFiles(target) {
    if (target.endsWith(".axaml")) return { files: [target], truncated: false };
    const files = [];
    let truncated = false;
    async function walk(dir) {
        for (const item of await readdir(dir, { withFileTypes: true })) {
            if (truncated) return;
            const full = path.join(dir, item.name);
            if (item.isDirectory()) {
                if (!SKIP.has(item.name)) await walk(full);
            } else if (item.name.endsWith(".axaml")) {
                // A symlinked file is only read when it resolves inside the repository.
                const real = await realpath(full).catch(() => null);
                if (!real || !isInside(real)) continue;
                if (files.length >= MAX_FILES) {
                    truncated = true;
                    return;
                }
                files.push(full);
            }
        }
    }
    await walk(target);
    return { files, truncated };
}

function attribute(attrs, name) {
    const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
    return match ? (match[1] ?? match[2]) : null;
}

// Blanks out comments but keeps the line breaks, so a commented-out control is not reported
// and the line numbers of the real ones stay right.
function withoutComments(text) {
    return text.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, " "));
}

function decodeEntities(text) {
    return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function suffixFor(type) {
    return { TextBox: "Box", ComboBox: "Combo", ToggleSwitch: "Toggle", MenuItem: "Menu" }[type] ?? type;
}

// "_Save as…" -> "SaveAs". A {Binding ...} has no text to name the control after.
function stemFrom(label) {
    if (!label || /^\s*\{/.test(label)) return "";
    return decodeEntities(label)
        .replace(/[^A-Za-z0-9 ]/g, "")
        .split(" ")
        .filter(Boolean)
        .map((word) => word[0].toUpperCase() + word.slice(1))
        .join("");
}

// Same stem and type, different place: OKButton, OK2Button... so the id stays unique and still ends with the type.
function uniqueId(stem, suffix, taken) {
    let id = stem + suffix;
    for (let n = 2; taken.has(id); n++) id = `${stem}${n}${suffix}`;
    taken.add(id);
    return id;
}

async function controlsIn(file) {
    const text = withoutComments(await readFile(file, "utf8"));
    const controls = [];
    // Attribute values are matched as quoted strings, so a ">" inside one does not end the tag.
    const tag = /<([A-Za-z][\w.]*)((?:"[^"]*"|'[^']*'|[^<>"'])*?)\/?>/g;
    for (const match of text.matchAll(tag)) {
        const type = match[1];
        if (!INTERACTIVE.has(type)) continue;
        const attrs = match[2] ?? "";
        const name = attribute(attrs, "Name") ?? attribute(attrs, "x:Name");
        const label = attribute(attrs, "Content") ?? attribute(attrs, "Header") ?? attribute(attrs, "Watermark");
        controls.push({
            type,
            name,
            automationId: attribute(attrs, "AutomationProperties\\.AutomationId"),
            label,
            file: path.relative(ROOT, file),
            line: text.slice(0, match.index).split("\n").length,
        });
    }
    return controls;
}

async function scan(args) {
    const { files, truncated } = await axamlFiles(await resolveInsideRoot(args?.path));
    const controls = (await Promise.all(files.map(controlsIn))).flat();
    return { files: files.length, truncated, controls };
}

async function callTool(name, args) {
    if (!TOOLS.some((tool) => tool.name === name)) throw new Error(`Unknown tool: ${name}`);
    const { files, truncated, controls } = await scan(args);
    const notice = truncated ? { note: `Only the first ${MAX_FILES} files were scanned. Ask again with a narrower path.` } : {};
    if (name === "list_controls") {
        return { files, truncated, ...notice, total: controls.length, controls };
    }
    const taken = new Set(controls.flatMap((control) => [control.automationId, control.name]).filter(Boolean));
    const missing = controls
        .filter((control) => !control.automationId)
        .map((control) => {
            const stem = stemFrom(control.label);
            const suggestedId = control.name ?? (stem ? uniqueId(stem, suffixFor(control.type), taken) : null);
            return { ...control, suggestedId };
        });
    return { files, truncated, ...notice, total: controls.length, missing: missing.length, controls: missing };
}

function send(message) {
    process.stdout.write(JSON.stringify(message) + "\n");
}

async function handle(request) {
    const { id, method, params } = request;
    const isNotification = id === undefined || id === null;
    try {
        switch (method) {
            case "initialize":
                return send({
                    jsonrpc: "2.0",
                    id,
                    result: {
                        protocolVersion: params?.protocolVersion ?? "2025-06-18",
                        capabilities: { tools: {} },
                        serverInfo: { name: "axaml-inspector", version: "0.1.0" },
                    },
                });
            case "ping":
                return send({ jsonrpc: "2.0", id, result: {} });
            case "tools/list":
                return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
            case "tools/call": {
                let result;
                try {
                    const data = await callTool(params?.name, params?.arguments);
                    result = { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
                } catch (error) {
                    result = { content: [{ type: "text", text: String(error.message ?? error) }], isError: true };
                }
                return send({ jsonrpc: "2.0", id, result });
            }
            default:
                if (!isNotification) {
                    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unsupported method: ${method}` } });
                }
        }
    } catch (error) {
        console.error("[axaml-inspector]", error);
        if (!isNotification) send({ jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error" } });
    }
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
        message = JSON.parse(line);
    } catch {
        return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } });
    }
    // A JSON value that is not an object (null, 5, a list) is not a request.
    if (!message || typeof message !== "object" || Array.isArray(message)) {
        return send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
    }
    handle(message).catch((error) => console.error("[axaml-inspector]", error));
});
console.error("[axaml-inspector] ready in", ROOT);
