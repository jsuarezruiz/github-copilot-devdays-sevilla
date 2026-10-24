// avalonia-tools: the smallest extension that shows the three parts of the SDK.
//   1. tools   -> a new tool for the agent
//   2. hooks   -> code that runs at points in the session lifecycle
//   3. events  -> watch what happens in the session
//
// It runs as a child Node process of Copilot and speaks JSON-RPC over stdio.
// That is why it NEVER uses console.log: stdout belongs to the protocol. Use session.log().

import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { joinSession } from "@github/copilot-sdk/extension";

const ROOT = await realpath(process.cwd());

function isInside(candidate) {
    return candidate === ROOT || candidate.startsWith(ROOT + path.sep);
}

// The tool only reads inside the repository, also when a symlink points somewhere else.
async function resolveInsideRepo(projectPath) {
    const target = path.resolve(ROOT, projectPath);
    if (!isInside(target)) throw new Error("The path must be inside the repository.");
    const real = await realpath(target).catch(() => {
        throw new Error(`Path not found: ${projectPath}`);
    });
    if (!isInside(real)) throw new Error("The path must be inside the repository.");
    return real;
}

// Same arguments as the file hooks get: a JSON string. An object is accepted too.
function parseToolArgs(toolArgs) {
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

// launchSettings.json can hold comments, which JSON.parse rejects: fall back to a text search.
function setsCanvasVariable(launchSettings) {
    if (launchSettings === null) return false;
    try {
        const profiles = Object.values(JSON.parse(launchSettings).profiles ?? {});
        return profiles.some((profile) => String(profile?.environmentVariables?.COPILOT_AVALONIA) === "1");
    } catch {
        return /"COPILOT_AVALONIA"\s*:\s*"1"/.test(launchSettings);
    }
}

async function findCsproj(projectPath) {
    const target = await resolveInsideRepo(projectPath);
    if ((await stat(target)).isFile()) return target;
    const csproj = (await readdir(target)).find((name) => name.endsWith(".csproj"));
    if (!csproj) throw new Error(`No .csproj found in ${projectPath}`);
    return path.join(target, csproj);
}

async function readIfExists(file) {
    try {
        return await readFile(file, "utf8");
    } catch {
        return null;
    }
}

async function projectInfo(projectPath) {
    const csprojPath = await findCsproj(projectPath);
    const dir = path.dirname(csprojPath);
    const csproj = await readFile(csprojPath, "utf8");
    const program = await readIfExists(path.join(dir, "Program.cs"));
    const launch = await readIfExists(path.join(dir, "Properties", "launchSettings.json"));

    const avalonia = /<PackageReference\s+Include="Avalonia"\s+Version="([^"]+)"/.exec(csproj)?.[1] ?? null;
    const framework = /<TargetFrameworks?>([^<]+)</.exec(csproj)?.[1] ?? null;
    const problems = [];
    if (program === null) {
        problems.push("No Program.cs next to the project, so UseCopilotAvalonia() could not be checked.");
    } else {
        const detect = program.indexOf("UsePlatformDetect(");
        const canvas = program.indexOf("UseCopilotAvalonia(");
        if (canvas === -1) problems.push("The AppBuilder is missing .UseCopilotAvalonia().");
        else if (detect !== -1 && canvas < detect) problems.push("UseCopilotAvalonia() must come after UsePlatformDetect().");
    }
    if (!setsCanvasVariable(launch)) problems.push("No launch profile sets COPILOT_AVALONIA=1.");

    return {
        project: path.relative(ROOT, csprojPath),
        targetFramework: framework,
        avaloniaVersion: avalonia,
        canvasReady: problems.length === 0,
        problems,
    };
}

let toolCalls = 0;

const session = await joinSession({
    // 1. TOOLS: the name must be unique across ALL loaded extensions.
    tools: [
        {
            name: "avalonia_project_info",
            description:
                "Checks whether an Avalonia project is ready to open in the Copilot.Avalonia canvas: " +
                "Avalonia version, target framework and whether UseCopilotAvalonia() is wired correctly.",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "Project folder or path to the .csproj, relative to the repo." },
                },
                required: ["path"],
            },
            handler: async (args) => {
                try {
                    return JSON.stringify(await projectInfo(args.path), null, 2);
                } catch (error) {
                    return { textResultForLlm: String(error.message ?? error), resultType: "failure" };
                }
            },
        },
    ],

    // 2. HOOKS: same lifecycle as file hooks, but in process and with state.
    hooks: {
        onUserPromptSubmitted: async (input) => {
            if (!/\b(canvas|ui|screen)\b/i.test(input.prompt)) return;
            return {
                additionalContext:
                    "Before opening an Avalonia canvas, call avalonia_project_info to confirm the project is ready.",
            };
        },
        onPreToolUse: async (input) => {
            const args = parseToolArgs(input.toolArgs);
            const command = args.command ?? args.raw;
            if (typeof command === "string" && /\bdotnet\s+nuget\s+push\b/.test(command)) {
                return {
                    permissionDecision: "deny",
                    permissionDecisionReason: "NuGet packages are only published from CI.",
                };
            }
        },
    },
});

// 3. EVENTS: watch without intervening.
session.on("tool.execution_complete", () => {
    toolCalls += 1;
});
session.on("session.idle", async () => {
    if (toolCalls === 0) return;
    await session.log(`avalonia-tools: ${toolCalls} tools run in this turn.`, { ephemeral: true });
    toolCalls = 0;
});

await session.log("avalonia-tools loaded: avalonia_project_info available.");
