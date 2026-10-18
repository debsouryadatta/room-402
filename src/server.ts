import { ADMIN_TOKEN, BASE_URL, PORT, PUBLIC_CONTROLS } from "./env.js";
import { readFileSync } from "node:fs";
import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { timingSafeEqual } from "node:crypto";
import { streamSSE } from "hono/streaming";
import { recent, runEvents, subscribe } from "./bus.js";
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

function isLoopback(c: Context) {
  const addr = getConnInfo(c).remote.address ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

// Operator actions (start runs, approve spend, lights out). Fail closed: without
// ROOM402_ADMIN_TOKEN only localhost may act; with it, the x-admin-token header must match.
function isOperator(c: Context) {
  if (PUBLIC_CONTROLS) return true; // demo mode: open controls (guardrails: model allowlist, one run at a time, run cap)
  if (!ADMIN_TOKEN) return isLoopback(c);
  const given = Buffer.from(c.req.header("x-admin-token") ?? "");
  const want = Buffer.from(ADMIN_TOKEN);
  return given.length === want.length && timingSafeEqual(given, want);
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

// "/" is the landing page (falls back to the arena); "/live" is the live arena.
app.get("/", (c) => {
  for (const f of ["public/landing.html", "public/index.html"]) {
    try {
      return c.html(readFileSync(f, "utf8"));
    } catch {}
  }
  return c.html("<h1>Room 402</h1>");
});
app.get("/live", (c) => {
  try {
    return c.html(readFileSync("public/index.html", "utf8"));
  } catch {
    return c.html("<h1>Room 402</h1><p>Arena page not built yet.</p>");
  }
});
app.get("/landing/:file", (c) => {
  const file = c.req.param("file");
  if (!/^[\w.-]+$/.test(file) || file.startsWith(".")) return c.notFound();
  const types: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml", gif: "image/gif" };
  const type = types[file.split(".").pop()!.toLowerCase()];
  if (!type) return c.notFound();
  try {
    c.header("Content-Type", type);
    c.header("Cache-Control", "public, max-age=3600");
    return c.body(readFileSync(`public/landing/${file}`));
  } catch {
    return c.notFound();
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

// Run history: every finished run (newest first), and one run's full event log.
app.get("/api/runs", (c) => c.json([...leaderboard()].sort((a, b) => b.startedAt - a.startedAt)));
app.get("/api/runs/:id", (c) => {
  const id = c.req.param("id");
  const result = leaderboard().find((r) => r.runId === id) ?? null;
  const events = runEvents(id);
  if (!result && events.length === 0) return c.json({ error: "unknown run" }, 404);
  return c.json({ result, events });
});

// ---------- model catalog (any OpenRouter model that supports tool calling, within a price cap) ----------
type ModelInfo = { id: string; name: string; provider: string; promptPerM: number; completionPerM: number; context: number };
const MAX_PROMPT_PER_M = 5; // USD per 1M input tokens; keeps open public runs cheap
const MAX_COMPLETION_PER_M = 25;
let modelCache: { at: number; models: ModelInfo[] } | null = null;
async function modelCatalog(): Promise<ModelInfo[]> {
  if (modelCache && Date.now() - modelCache.at < 10 * 60_000) return modelCache.models;
  const res = await fetch("https://openrouter.ai/api/v1/models");
  const json: any = await res.json();
  const models: ModelInfo[] = (json.data ?? [])
    .filter((m: any) => (m.supported_parameters ?? []).includes("tools"))
    // Fail closed on pricing: every listed fee must be a finite number >= 0, and per-request,
    // reasoning and web-search surcharges must be zero.
    .filter((m: any) => {
      const p = m.pricing ?? {};
      const fees = ["prompt", "completion"].map((k) => Number(p[k]));
      if (fees.some((v) => !Number.isFinite(v) || v < 0)) return false;
      return ["request", "internal_reasoning", "web_search"].every((k) => p[k] === undefined || Number(p[k]) === 0);
    })
    .map((m: any) => ({
      id: String(m.id),
      name: String(m.name ?? m.id).replace(/^[^:]+:\s*/, ""),
      provider: String(m.id).split("/")[0],
      promptPerM: Number(m.pricing.prompt) * 1e6,
      completionPerM: Number(m.pricing.completion) * 1e6,
      context: Number(m.context_length ?? 0),
    }))
    .filter((m: ModelInfo) => m.promptPerM >= 0 && m.promptPerM <= MAX_PROMPT_PER_M && m.completionPerM <= MAX_COMPLETION_PER_M)
    .sort((a: ModelInfo, b: ModelInfo) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
  modelCache = { at: Date.now(), models };
  return models;
}
app.get("/api/models", async (c) => {
  try {
    return c.json(await modelCatalog());
  } catch (e: any) {
    return c.json({ error: e.message }, 502);
  }
});

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
    const known = MODELS.some((m) => m.id === model) || (await modelCatalog().catch(() => [] as ModelInfo[])).some((m) => m.id === model);
    if (!known) return c.json({ error: "unknown model: pick a tool-calling OpenRouter model from /api/models" }, 400);
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
