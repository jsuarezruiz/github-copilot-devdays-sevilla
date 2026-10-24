// ui-test-plan: the smallest canvas that is truly two-way.
//   - The person marks cases, adds cases and clicks "Ask Copilot to run it".
//   - The agent reads and updates the same plan through actions (invoke_canvas_action).
//
// Anatomy: createCanvas({ open, actions, onClose }) + joinSession({ canvases }).
// The UI is a web page served on loopback; the state lives in this process.

import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";

const STATUSES = ["pending", "passed", "failed"];
const MAX_BODY_BYTES = 16 * 1024;
const instances = new Map(); // instanceId -> { server, url, token, cases, nextId }
let session;

function state(instanceId) {
    const found = instances.get(instanceId);
    if (!found) throw new CanvasError("not_open", "This canvas is not open. Open it with open_canvas.");
    return found;
}

function addCase(plan, input) {
    const title = String(input?.title ?? "").trim().slice(0, 200);
    if (!title) throw new CanvasError("invalid_input", "A case needs a title.");
    const item = { id: plan.nextId++, title, status: "pending", note: "" };
    plan.cases.push(item);
    return item;
}

function setStatus(plan, input) {
    const item = plan.cases.find((candidate) => candidate.id === Number(input?.id));
    if (!item) throw new CanvasError("not_found", `Case ${input?.id} does not exist.`);
    if (!STATUSES.includes(input?.status)) {
        throw new CanvasError("invalid_input", `status must be one of: ${STATUSES.join(", ")}.`);
    }
    item.status = input.status;
    // A status change from the page carries no note: keep the one the agent left. An explicit "" clears it.
    if (input.note != null) item.note = String(input.note).slice(0, 500);
    return item;
}

function summary(plan) {
    const count = (status) => plan.cases.filter((item) => item.status === status).length;
    return { total: plan.cases.length, pending: count("pending"), passed: count("passed"), failed: count("failed"), cases: plan.cases };
}

const PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>UI test plan</title>
<style>
  body { margin: 0; padding: 24px; font: 15px/1.5 var(--font-sans, system-ui, sans-serif);
         background: var(--background-color-default, #ffffff); color: var(--text-color-default, #1f2328); }
  @media (prefers-color-scheme: dark) { body { background: var(--background-color-default, #0d1117); color: var(--text-color-default, #e6edf3); } }
  h1 { font-size: 20px; margin: 0 0 4px; }
  #totals { opacity: .7; margin: 0 0 16px; }
  li { display: flex; gap: 12px; align-items: center; padding: 10px 0; border-bottom: 1px solid #8884; }
  ul { list-style: none; padding: 0; margin: 0 0 16px; }
  .title { flex: 1; }
  .note { display: block; opacity: .7; font-size: 13px; }
  button, input { font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid #8886; background: transparent; color: inherit; }
  button { cursor: pointer; }
  button.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; }
  form { display: flex; gap: 8px; margin-bottom: 16px; }
  form input { flex: 1; }
  .passed { color: #1a7f37; } .failed { color: #cf222e; }
</style>
<h1>UI test plan</h1>
<p id="totals"></p>
<form id="add"><input id="title" placeholder="New case: what to check" required><button>Add</button></form>
<ul id="cases"></ul>
<button class="primary" id="run">Ask Copilot to run it</button>
<script>
  const LABEL = { pending: "Pending", passed: "Passed", failed: "Failed" };
  const NEXT = { pending: "passed", passed: "failed", failed: "pending" };
  const post = (route, body) => fetch(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  let last = "";
  async function refresh() {
    const text = await (await fetch("state")).text();
    if (text === last) return;
    last = text;
    const plan = JSON.parse(text);
    document.getElementById("totals").textContent =
      plan.total + " cases · " + plan.passed + " passed · " + plan.failed + " failed · " + plan.pending + " pending";
    const list = document.getElementById("cases");
    list.replaceChildren(...plan.cases.map((item) => {
      const row = document.createElement("li");
      const title = document.createElement("span");
      title.className = "title";
      title.textContent = item.id + ". " + item.title;
      if (item.note) { const note = document.createElement("span"); note.className = "note"; note.textContent = item.note; title.append(note); }
      const button = document.createElement("button");
      button.className = item.status;
      button.textContent = LABEL[item.status];
      button.onclick = async () => { await post("status", { id: item.id, status: NEXT[item.status] }); refresh(); };
      row.append(title, button);
      return row;
    }));
  }
  document.getElementById("add").onsubmit = async (event) => {
    event.preventDefault();
    const input = document.getElementById("title");
    await post("add", { title: input.value });
    input.value = "";
    refresh();
  };
  document.getElementById("run").onclick = () => post("run");
  refresh();
  setInterval(refresh, 1000);
</script>
</html>`;

function readJson(request) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        request.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error("too_large"));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on("end", () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
            } catch {
                reject(new Error("bad_json"));
            }
        });
        request.on("error", reject);
    });
}

function startServer(instanceId, plan) {
    const prefix = `/${plan.token}/`;
    const server = createServer(async (request, response) => {
        const json = (code, body) => {
            response.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
            response.end(JSON.stringify(body));
        };
        // The token in the path is the only secret: without it, 404.
        if (!request.url?.startsWith(prefix)) return json(404, { error: "not_found" });
        const route = request.url.slice(prefix.length).split("?")[0];
        try {
            if (request.method === "GET" && route === "") {
                response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
                return response.end(PAGE);
            }
            if (request.method === "GET" && route === "state") return json(200, summary(plan));
            if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
            const body = await readJson(request);
            if (route === "add") return json(200, addCase(plan, body));
            if (route === "status") return json(200, setStatus(plan, body));
            if (route === "run") {
                // From the canvas to the agent: the UI does not do the work, it asks the session.
                await session.send({
                    prompt:
                        `Run the test plan in canvas "${instanceId}". Read the cases with the get_plan action, ` +
                        "check each pending case and record the result with set_status (passed or failed, with a short note).",
                });
                return json(202, { requested: true });
            }
            return json(404, { error: "not_found" });
        } catch (error) {
            return json(400, { error: String(error.message ?? error) });
        }
    });
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        // Loopback only: never 0.0.0.0. Port 0 = the OS picks a free one.
        server.listen(0, "127.0.0.1", () => resolve(server));
    });
}

const canvas = createCanvas({
    id: "ui-test-plan",
    displayName: "UI test plan",
    description:
        "Shared list of UI test cases. The person and the agent add cases and mark each one as pending, passed or failed.",
    inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
            cases: { type: "array", items: { type: "string" }, description: "Initial cases (titles)." },
        },
    },
    actions: [
        {
            name: "get_plan",
            description: "Returns every case with its status and the totals.",
            handler: (ctx) => summary(state(ctx.instanceId)),
        },
        {
            name: "add_case",
            description: "Adds a pending test case.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: { title: { type: "string", description: "What to check.", minLength: 1, maxLength: 200 } },
                required: ["title"],
            },
            handler: (ctx) => addCase(state(ctx.instanceId), ctx.input),
        },
        {
            name: "set_status",
            description: "Marks a case as pending, passed or failed, with an optional note on what was observed.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    id: { type: "integer", description: "Case identifier." },
                    status: { type: "string", enum: STATUSES },
                    note: { type: "string", description: "What was observed.", maxLength: 500 },
                },
                required: ["id", "status"],
            },
            handler: (ctx) => setStatus(state(ctx.instanceId), ctx.input),
        },
    ],
    // open can be called more than once with the same instanceId: it must be idempotent.
    // The instance is registered before the server starts, so a second call waits for the first one.
    open: async (ctx) => {
        let plan = instances.get(ctx.instanceId);
        if (!plan) {
            plan = { token: randomBytes(18).toString("hex"), cases: [], nextId: 1, server: null, url: null, ready: null };
            for (const title of ctx.input?.cases ?? []) addCase(plan, { title });
            instances.set(ctx.instanceId, plan);
            plan.ready = startServer(ctx.instanceId, plan).then((server) => {
                plan.server = server;
                plan.url = `http://127.0.0.1:${server.address().port}/${plan.token}/`;
            });
            // If the server cannot start, forget the instance so a later open can try again.
            plan.ready.catch(() => {
                if (instances.get(ctx.instanceId) === plan) instances.delete(ctx.instanceId);
            });
        }
        await plan.ready;
        return { title: "UI test plan", status: `${plan.cases.length} cases`, url: plan.url };
    },
    onClose: async (ctx) => {
        const plan = instances.get(ctx.instanceId);
        instances.delete(ctx.instanceId);
        await plan?.ready?.catch(() => {}); // closing while the server is still starting
        if (!plan?.server) return;
        plan.server.closeAllConnections(); // the page keeps polling: cut its connections
        await new Promise((resolve) => plan.server.close(resolve));
    },
});

session = await joinSession({ canvases: [canvas] });
await session.log("ui-test-plan loaded: canvas available.");

session.on("session.shutdown", () => {
    for (const plan of instances.values()) {
        plan.server?.closeAllConnections(); // the page keeps polling: cut its connections
        plan.server?.close();
    }
    instances.clear();
});
