import { ADMIN_TOKEN, BASE_URL, PORT } from "./env.js";
import { readFileSync } from "node:fs";
import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { streamSSE } from "hono/streaming";
import { recent, subscribe } from "./bus.js";
import { currentRun, getRun, leaderboard } from "./game.js";
import type { RoomId, Tier } from "./types.js";

export { BASE_URL, PORT };

const app = new Hono();
let starting = false;

async function body(c: Context): Promise<Record<string, any>> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

function runFor(c: Context, b: Record<string, any> = {}) {
  const run = getRun((b.run as string) || c.req.query("run") || null);
  // Agent-facing routes only answer the run's own agent loop (per-run secret).
  return run && c.req.header("x-run-token") === run.agentToken ? run : undefined;
}

function isOperator(c: Context) {
  return !ADMIN_TOKEN || c.req.header("x-admin-token") === ADMIN_TOKEN || c.req.query("key") === ADMIN_TOKEN;
}

// ---------- agent-facing: Hint Shop (HTTP 402), wallet, doors ----------

app.get("/hint/:room/:tier", (c) => {
  const run = runFor(c);
  if (!run) return c.json({ error: "no_active_run" }, 404);
  const res = run.requestHint(c.req.param("room") as RoomId, c.req.param("tier") as Tier);
  if (res.status === 402) {
    const b = res.body;
    c.header("WWW-Authenticate", `Payment realm="room402", invoice_id="${b.invoice_id}", amount="${b.price_usd}", currency="usd"`);
  }
  return c.json(res.body, res.status);
});

app.post("/pay", async (c) => {
  const b = await body(c);
  const run = runFor(c, b);
  if (!run) return c.json({ ok: false, error: "no_active_run" }, 404);
  const res = await run.pay(String(b.invoice_id ?? ""));
  return c.json(res, res.ok ? 200 : 402);
});

app.post("/door", async (c) => {
  const b = await body(c);
  const run = runFor(c, b);
  if (!run) return c.json({ ok: false, message: "no_active_run", fine_cents: 0 }, 404);
  return c.json(run.openDoor(b.room as RoomId, String(b.key ?? "")));
});

app.post("/approval", async (c) => {
  const b = await body(c);
  const run = runFor(c, b);
  if (!run) return c.json({ error: "no_active_run" }, 404);
  const approvalId = run.requestApproval(Number(b.amount_cents ?? 0), String(b.reason ?? ""));
  return c.json({ approval_id: approvalId, status: "pending" });
});

app.get("/approval/:id", (c) => {
  const run = runFor(c);
  const status = run?.approvalStatus(c.req.param("id"));
  return status ? c.json(status) : c.json({ error: "unknown_approval" }, 404);
});

app.post("/giveup", async (c) => {
  const b = await body(c);
  const run = runFor(c, b);
  if (!run) return c.json({ ok: false, message: "no_active_run" }, 404);
  return c.json(run.giveUp(b.room as RoomId, String(b.reason ?? "")));
});

// ---------- spectator ----------

app.get("/", (c) => {
  try {
    return c.html(readFileSync("public/index.html", "utf8"));
  } catch {
    return c.html("<h1>Room 402</h1><p>Spectator page not built yet.</p>");
  }
});

for (const [file, type] of [
  ["logo.svg", "image/svg+xml"],
  ["favicon.svg", "image/svg+xml"],
  ["logo-32.png", "image/png"],
  ["logo-180.png", "image/png"],
  ["logo-512.png", "image/png"],
] as const) {
  app.get(`/${file}`, (c) => {
    c.header("Content-Type", type);
    c.header("Cache-Control", "public, max-age=3600");
    return c.body(readFileSync(`public/${file}`));
  });
}

app.get("/events", (c) =>
  streamSSE(c, async (stream) => {
    let aborted = false;
    const unsubscribe = subscribe((e) => {
      void stream.writeSSE({ data: JSON.stringify(e) });
    });
    stream.onAbort(() => {
      aborted = true;
      unsubscribe();
    });
    const run = currentRun();
    if (run) for (const e of recent(run.runId)) await stream.writeSSE({ data: JSON.stringify(e) });
    while (!aborted) {
      await stream.sleep(15_000);
      if (!aborted) await stream.writeSSE({ event: "ping", data: String(Date.now()) });
    }
  }),
);

app.get("/api/state", (c) => {
  const run = currentRun();
  return c.json({ run: run?.snapshot() ?? null, starting });
});

app.get("/api/leaderboard", (c) => c.json(leaderboard()));

app.post("/api/run", async (c) => {
  if (!isOperator(c)) return c.json({ error: "operator token required" }, 401);
  const b = await body(c);
  const active = currentRun();
  if (starting || (active && !active.isOver())) return c.json({ error: "a run is already in progress" }, 409);
  const model = String(b.model || "anthropic/claude-haiku-5.5");
  const seed = Number.isFinite(Number(b.seed)) && b.seed !== undefined && b.seed !== "" ? Number(b.seed) : 402;
  starting = true;
  try {
    const { startRun, MODELS } = await import("./runner.js");
    if (!MODELS.some((m) => m.id === model)) return c.json({ error: `unknown model; use one of ${MODELS.map((m) => m.id).join(", ")}` }, 400);
    return c.json(await startRun({ model, seed }));
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  } finally {
    starting = false;
  }
});

app.post("/api/approval/:id", async (c) => {
  if (!isOperator(c)) return c.json({ ok: false, error: "operator token required" }, 401);
  const b = await body(c);
  const run = currentRun();
  const ok = run?.decideApproval(c.req.param("id"), Boolean(b.approved));
  return ok ? c.json({ ok: true }) : c.json({ ok: false, error: "unknown or already decided" }, 404);
});

app.post("/api/lights", async (c) => {
  if (!isOperator(c)) return c.json({ ok: false, error: "operator token required" }, 401);
  const b = await body(c);
  const run = currentRun();
  if (!run || run.isOver()) return c.json({ error: "no_active_run" }, 404);
  run.setLights(Boolean(b.on));
  return c.json({ ok: true, on: run.lightsOn });
});

app.get("/health", (c) => c.json({ ok: true }));

serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" }, () => {
  console.log(`Room 402 listening on ${BASE_URL}`);
});

export default app;
