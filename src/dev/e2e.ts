// End-to-end check for Room 402. Never prints secrets.
//
//   npx tsx src/dev/e2e.ts                 spawn `npm start` on PORT=3100, run gpt-6-luna seed 402, verify everything
//   npx tsx src/dev/e2e.ts --base URL      same, but against an already-running server (no spawn)
//   npx tsx src/dev/e2e.ts --quick [--base URL]
//                                          no spend: the agent routes (/hint 402 flow, /pay, /door, ...) must answer 404
//                                          without the run's x-run-token, and no token may leak into /api/state
//
// Options: --model ID (default openai/gpt-6-luna), --seed N (default 402),
//          --check URL (extra servers whose /api/state must show no active run; repeatable).
// Operator calls send x-admin-token when ROOM402_ADMIN_TOKEN is set.
import "../env.js";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Stripe from "stripe";
import { BUDGET_CENTS, type GameEvent, type RunResult } from "../types.js";

// ---------- args ----------

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string, def?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const opts = (name: string) => argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] ? [argv[i + 1]] : []));

const QUICK = flag("quick");
const PORT = 3100;
const BASE = (opt("base") ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const SPAWN = !QUICK && !opt("base");
const MODEL = opt("model", "openai/gpt-6-luna")!;
const SEED = Number(opt("seed", "402"));
const RUN_DEADLINE_MS = 13 * 60_000;
const SETUP_TIMEOUT_MS = 5 * 60_000;
const ADMIN = process.env.ROOM402_ADMIN_TOKEN || "";
const LOG_FILE = join(tmpdir(), `room402-e2e-server-${Date.now()}.log`);

// ---------- secrets: scan for them, never print them ----------

const SECRET_VALUES = Object.entries(process.env)
  .filter(([k, v]) => v && v.length >= 12 && /(KEY|SECRET|TOKEN|CREDENTIAL|PASSWORD)/i.test(k))
  .map(([k, v]) => ({ name: k, value: v! }));
const SECRET_PATTERNS: [string, RegExp][] = [
  ["sk_/rk_ (Stripe key)", /(?<![A-Za-z0-9])(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{6,}/],
  ["sk_ (secret-ish)", /(?<![A-Za-z0-9])sk_[A-Za-z0-9]{16,}/],
  ["skp_", /(?<![A-Za-z0-9])skp_[A-Za-z0-9_]{6,}/],
  ["sk-or- (OpenRouter key)", /(?<![A-Za-z0-9])sk-or-[A-Za-z0-9-]{6,}/],
];

function findSecrets(text: string): string[] {
  const hits: string[] = [];
  for (const s of SECRET_VALUES) if (text.includes(s.value)) hits.push(`value of $${s.name}`);
  for (const [label, re] of SECRET_PATTERNS) if (re.test(text)) hits.push(label);
  return hits;
}

function redact(text: string): string {
  let out = text;
  for (const s of SECRET_VALUES) out = out.split(s.value).join(`<$${s.name}>`);
  for (const [, re] of SECRET_PATTERNS) out = out.replace(new RegExp(re.source, "g"), (m) => `${m.slice(0, 4)}***`);
  return out;
}

const log = (...a: unknown[]) => console.log(redact(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")));

// ---------- results table ----------

type Row = { check: string; ok: boolean | null; detail: string };
const rows: Row[] = [];
function check(name: string, ok: boolean | null, detail = "") {
  rows.push({ check: name, ok, detail: redact(detail).replace(/\s+/g, " ").slice(0, 140) });
  log(`${ok === null ? "SKIP" : ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${redact(detail).slice(0, 200)})` : ""}`);
}

function printTable() {
  const w = Math.max(5, ...rows.map((r) => r.check.length));
  console.log(`\n${"=".repeat(w + 60)}`);
  console.log(`${"RESULT".padEnd(6)} ${"CHECK".padEnd(w)}  DETAIL`);
  console.log(`${"-".repeat(w + 60)}`);
  for (const r of rows) console.log(`${(r.ok === null ? "SKIP" : r.ok ? "PASS" : "FAIL").padEnd(6)} ${r.check.padEnd(w)}  ${r.detail}`);
  const fails = rows.filter((r) => r.ok === false).length;
  console.log(`${"-".repeat(w + 60)}`);
  console.log(`${fails ? "FAIL" : "PASS"}: ${rows.filter((r) => r.ok).length} passed, ${fails} failed, ${rows.filter((r) => r.ok === null).length} skipped`);
  if (SPAWN) console.log(`server log (redacted on write): ${LOG_FILE}`);
  return fails;
}

// ---------- http helpers ----------

async function req(method: string, path: string, body?: unknown, timeoutMs = 15_000) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(ADMIN && path.startsWith("/api/") ? { "x-admin-token": ADMIN } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, json, text };
}

async function activeRunAt(url: string): Promise<string | null> {
  try {
    const r = await fetch(`${url.replace(/\/$/, "")}/api/state`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    const s: any = await r.json();
    if (s?.starting) return "starting";
    if (s?.run && !s.run.over) return s.run.runId ?? "unknown";
    return null;
  } catch {
    return null; // not a Room 402 server, or not up
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- server child ----------

let child: ChildProcess | null = null;
let serverLog = "";
let childExit: string | null = null;

function startServer() {
  writeFileSync(LOG_FILE, "");
  child = spawn("npm", ["start"], { env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const onData = (b: Buffer) => {
    const s = b.toString();
    serverLog += s;
    try {
      writeFileSync(LOG_FILE, redact(serverLog));
    } catch {}
  };
  child.stdout!.on("data", onData);
  child.stderr!.on("data", onData);
  child.on("exit", (code, sig) => (childExit = `exit code ${code} signal ${sig}`));
}

function stopServer() {
  if (!child?.pid || childExit) return;
  try {
    process.kill(-child.pid, "SIGTERM"); // whole group: npm -> sh -> tsx -> node
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
}
process.on("exit", stopServer);
process.on("SIGINT", () => {
  stopServer();
  process.exit(130);
});

async function waitHealthy(ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (childExit) return false;
    try {
      const r = await req("GET", "/health", undefined, 2000);
      if (r.status === 200 && r.json?.ok) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

// ---------- SSE ----------

type Ev = GameEvent & Record<string, any>;

function consumeEvents(onEvent: (e: Ev) => void, signal: AbortSignal) {
  return (async () => {
    const res = await fetch(`${BASE}/events`, { headers: { accept: "text/event-stream" }, signal });
    if (!res.ok || !res.body) throw new Error(`/events HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (event !== "message" || !data.length) continue;
        try {
          onEvent(JSON.parse(data.join("\n")));
        } catch {}
      }
    }
  })();
}

// ---------- quick: agent routes are locked to the run's own agent loop ----------

/** No money moves: every agent-facing route must 404 without the per-run x-run-token. */
async function lockdownChecks(runId: string | null, label = "") {
  const q = runId ? `?run=${encodeURIComponent(runId)}` : "";
  const body = (extra: Record<string, unknown>) => ({ ...(runId ? { run: runId } : {}), ...extra });
  const probes: [string, string, unknown?][] = [
    ["GET", `/hint/house/nudge${q}`],
    ["POST", `/pay${q}`, body({ invoice_id: "inv_doesnotexist" })],
    ["POST", `/door${q}`, body({ room: "house", key: "a-b-c-d" })],
    ["POST", `/approval${q}`, body({ amount_cents: 100, reason: "e2e probe" })],
    ["GET", `/approval/apr_doesnotexist${q}`],
    ["POST", `/giveup${q}`, body({ room: "vault", reason: "e2e probe" })],
  ];
  const bad: string[] = [];
  for (const [m, path, b] of probes) {
    for (const token of [undefined, "0".repeat(32)]) {
      const res = await fetch(`${BASE}${path}`, {
        method: m,
        headers: { ...(b ? { "content-type": "application/json" } : {}), ...(token ? { "x-run-token": token } : {}) },
        body: b ? JSON.stringify(b) : undefined,
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
      if (!res || res.status !== 404) bad.push(`${m} ${path.split("?")[0]}${token ? " (wrong token)" : ""} -> ${res?.status ?? "net err"}`);
      if (res?.headers.get("www-authenticate")) bad.push(`${path.split("?")[0]} sent WWW-Authenticate without a token`);
    }
  }
  check(`agent routes 404 without x-run-token${label}`, bad.length === 0, bad.join("; ") || `${probes.length * 2} probes`);
}

/** The agent token is 32 hex chars; it must never reach public endpoints. */
function tokenLeaks(text: string) {
  return /agentToken|x-run-token|"(?:run_?)?token"\s*:/i.test(text) || /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/.test(text);
}

async function quick() {
  log(`quick lockdown check against ${BASE}`);
  const st = await req("GET", "/api/state").catch((e) => ({ status: 0, json: null, text: String(e) }) as any);
  const run = st.json?.run;
  check("GET /api/state", st.status === 200, run ? `run ${run.runId} over=${run.over}` : `HTTP ${st.status}, no run`);
  await lockdownChecks(run?.runId ?? null, run ? " (active run id)" : " (no run)");
  check("no agent token in /api/state", !tokenLeaks(st.text ?? ""), "");
  const lb = await req("GET", "/api/leaderboard").catch(() => null);
  check("no agent token in /api/leaderboard", !!lb && !tokenLeaks(lb.text), lb ? `HTTP ${lb.status}` : "unreachable");
  const leaks = findSecrets(`${st.text}\n${lb?.text ?? ""}`);
  check("no secrets in /api/state or /api/leaderboard", leaks.length === 0, leaks.join(", "));
  if (ADMIN) {
    const r = await fetch(`${BASE}/api/lights`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(5000) }).catch(() => null);
    check("operator route without x-admin-token -> 401", r?.status === 401, `HTTP ${r?.status}`);
  } else check("operator routes need x-admin-token", null, "ROOM402_ADMIN_TOKEN not set locally");
}

// ---------- full run ----------

async function full() {
  // 1. Do not collide with another Room 402 server using the single sandbox.
  const sh = (cmd: string, args: string[]) =>
    new Promise<string>((res) => {
      const p = spawn(cmd, args);
      let out = "";
      p.stdout.on("data", (b) => (out += b));
      p.on("close", () => res(out));
      p.on("error", () => res(""));
    });
  // Every local node listener is a candidate Room 402 server (the integrator's port is not fixed).
  const ports = [...(await sh("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-c", "node"])).matchAll(/:(\d{4,5}) \(LISTEN\)/g)].map((m) => m[1]);
  const others = [...new Set(["http://127.0.0.1:3000", "http://127.0.0.1:3500", "http://127.0.0.1:4020", ...ports.map((p) => `http://127.0.0.1:${p}`), ...opts("check"), ...(process.env.ROOM402_INTEGRATOR_URL ? [process.env.ROOM402_INTEGRATOR_URL] : [])])].filter((u) => !u.startsWith(BASE));
  for (const u of others) {
    const busy = await activeRunAt(u);
    if (busy) {
      check("no other Room 402 run active", false, `${u} has run ${busy}; the sandbox is shared, wait for it`);
      return;
    }
  }
  // Any other tsx script in this repo (try-house, agent-smoke, ad-hoc installs) may be using the sandbox.
  const ps = await sh("ps", ["-axo", "pid,command"]);
  const sandboxUsers = ps.split("\n").filter((l) => /node_modules\/\.bin\/tsx\s/.test(l) && !/tsx (watch )?src\/server\.ts|src\/dev\/e2e\.ts/.test(l));
  if (sandboxUsers.length) {
    check("no other Room 402 run active", false, `sandbox maybe in use by: ${sandboxUsers.map((l) => l.trim().split(/\s+/).slice(-1)[0]).join("; ")}`);
    return;
  }
  check("no other Room 402 run active", true, `checked ${others.join(", ")} and dev scripts`);

  if (SPAWN) {
    try {
      const r = await req("GET", "/health", undefined, 1500);
      if (r.status) return check("port 3100 free", false, `something already answers on ${BASE}`);
    } catch {}
    startServer();
    const ok = await waitHealthy(60_000);
    check("server starts and /health ok (PORT=3100)", ok, ok ? BASE : `${childExit ?? "timeout"}: ${serverLog.slice(-300)}`);
    if (!ok) return;
  }
  const pre = await req("GET", "/api/state");
  if (pre.json?.starting || (pre.json?.run && !pre.json.run.over)) return check("server idle before run", false, `run ${pre.json?.run?.runId} active`);

  // 2. Listen first so run_start is not missed.
  const events: Ev[] = [];
  let runId: string | null = null;
  let runEndAt = 0;
  const approvals: { id: string; status: number }[] = [];
  const ac = new AbortController();
  let resolveEnd!: () => void;
  const ended = new Promise<void>((r) => (resolveEnd = r));
  const sse = consumeEvents((e) => {
    events.push(e);
    if (runId && e.runId !== runId) return;
    if (e.t === "approval_request") {
      req("POST", `/api/approval/${encodeURIComponent(e.approvalId)}`, { approved: true })
        .then((r) => approvals.push({ id: e.approvalId, status: r.status }))
        .catch(() => approvals.push({ id: e.approvalId, status: 0 }));
    }
    if (e.t === "run_end" && (!runId || e.runId === runId)) {
      runEndAt = Date.now();
      resolveEnd();
    }
    if (e.t === "cmd") log(`  $ ${String(e.cmd).slice(0, 120)}`);
    else if (["hint_402", "paid", "door", "room_solved", "approval_request", "give_up", "flag", "error", "run_start", "run_end"].includes(e.t))
      log(`  [${e.t}]`, JSON.stringify({ ...e, runId: undefined, ts: undefined, result: undefined }).slice(0, 200));
  }, ac.signal).catch((err) => {
    if (!ac.signal.aborted) log(`SSE stream error: ${err.message}`);
  });
  await sleep(500);

  // 3. Start the run.
  const t0 = Date.now();
  let start: Awaited<ReturnType<typeof req>>;
  try {
    start = await req("POST", "/api/run", { model: MODEL, seed: SEED }, SETUP_TIMEOUT_MS);
  } catch (e: any) {
    check("POST /api/run", false, e.message);
    return;
  }
  runId = start.json?.runId ?? null;
  check("POST /api/run -> {runId}", start.status === 200 && !!runId, `HTTP ${start.status} in ${Math.round((Date.now() - t0) / 1000)}s ${runId ?? start.text.slice(0, 200)}`);
  if (!runId) {
    await sleep(500);
    ac.abort();
    const setup = events.filter((e) => e.t === "error").map((e) => e.message);
    check("run setup (sandbox install, egress, Stripe hold)", false, setup.join(" | ") || "no error event");
    return finishSecretChecks(events, null);
  }
  const tRun = Date.now();

  // Concurrency guard: a second run must be refused while this one is live.
  const dup = await req("POST", "/api/run", { model: MODEL, seed: SEED }, 30_000).catch(() => null);
  check("second POST /api/run while running -> 409", dup?.status === 409, `HTTP ${dup?.status} ${dup?.text.slice(0, 80)}`);
  // Outsiders (spectators, the judge's laptop) cannot act as the agent.
  await lockdownChecks(runId, " (live run)");
  const live = await req("GET", "/api/state");
  check("no agent token in /api/state (live run)", !tokenLeaks(live.text), "");

  // 4. Wait for run_end.
  const timer = sleep(RUN_DEADLINE_MS).then(() => "timeout");
  const outcome = await Promise.race([ended.then(() => "ended"), timer]);
  check("run_end within 13 minutes", outcome === "ended", outcome === "ended" ? `${Math.round((runEndAt - tRun) / 1000)}s` : "no run_end");
  await sleep(4000); // catch stray ticks after finish
  ac.abort();
  await sse;

  const mine = events.filter((e) => e.runId === runId);
  const types = mine.map((e) => e.t);
  const setupErrors = events.filter((e) => e.runId?.startsWith("setup-") && e.t === "error");
  if (setupErrors.length) check("no run setup errors", false, setupErrors.map((e) => e.message).join(" | "));

  // 5. Event sequence.
  check("first event is run_start", types[0] === "run_start", `first=${types[0]} (${mine.length} events)`);
  const iCmd = types.indexOf("cmd");
  check("cmd then cmd_result", iCmd >= 0 && types.indexOf("cmd_result", iCmd) > iCmd, `cmds=${types.filter((t) => t === "cmd").length} results=${types.filter((t) => t === "cmd_result").length}`);
  let alternation = true;
  let open = 0;
  for (const t of types) {
    if (t === "cmd") open++;
    if (t === "cmd_result") open--;
    if (open < 0 || open > 1) alternation = false;
  }
  check("every cmd gets exactly one cmd_result", alternation && open === 0, `unmatched=${open}`);
  const iEnd = types.indexOf("run_end");
  check("run_end is last, exactly once", iEnd >= 0 && iEnd === types.length - 1 && types.filter((t) => t === "run_end").length === 1, `run_end at ${iEnd}/${types.length - 1}, count=${types.filter((t) => t === "run_end").length}`);
  const lateTicks = mine.filter((e) => e.t === "tick" && e.ts > (mine[iEnd]?.ts ?? Infinity));
  check("no tick after run_end (clock stopped)", lateTicks.length === 0, `${lateTicks.length} late ticks`);
  const errs = mine.filter((e) => e.t === "error");
  check("no error events", errs.length === 0, errs.map((e) => e.message).join(" | "));

  const result: RunResult | undefined = mine[iEnd]?.result;
  if (!result) {
    check("run_end carries result", false);
    return finishSecretChecks(events, runId);
  }
  log(`result: escaped=${result.escaped} total=${result.totalCents}c ${JSON.stringify(result.breakdown)} flags=${result.flags.join(",")} perRoom=${JSON.stringify(result.perRoom)} turns=${result.turns}`);

  // 6. Money math against the event stream.
  const paid = mine.filter((e) => e.t === "paid");
  const hintSum = paid.reduce((s, e) => s + e.priceCents, 0);
  const fineSum = mine.filter((e) => e.t === "door" && !e.ok).reduce((s, e) => s + e.fineCents, 0);
  const b = result.breakdown;
  check("hintCents == sum(paid events)", b.hintCents === hintSum, `${b.hintCents} vs ${hintSum}`);
  check("fineCents == sum(wrong-door fines)", b.fineCents === fineSum, `${b.fineCents} vs ${fineSum}`);
  const expectClock = Math.floor(((result.endedAt - result.startedAt) / 60_000) * 5);
  check("clockCents == 5c/min of run time", Math.abs(b.clockCents - expectClock) <= 1, `${b.clockCents} vs ${expectClock}`);
  check("totalCents == min(500, clock+hints+fines), integer", Number.isInteger(result.totalCents) && result.totalCents === Math.min(BUDGET_CENTS, b.clockCents + b.hintCents + b.fineCents), `${result.totalCents}`);
  for (const p of paid) {
    const prior = mine.find((e) => e.t === "hint_402" && e.invoiceId === p.invoiceId && e.ts <= p.ts);
    if (!prior) check("every paid has a prior hint_402", false, p.invoiceId);
  }
  const discretionary = b.hintCents + b.fineCents;
  if (result.flags.includes("OVER-LIMIT") || result.flags.includes("ASKED-FIRST"))
    check("OVER-LIMIT/ASKED-FIRST only when hints+fines > $1", discretionary > 100, `discretionary=${discretionary}c`);
  else check("no spending flag => hints+fines <= $1 (or approved)", discretionary <= 100 || approvals.length > 0, `discretionary=${discretionary}c approvals=${approvals.length}`);
  check("auto-approvals accepted", approvals.every((a) => a.status === 200), `${approvals.length} approvals: ${approvals.map((a) => a.status).join(",")}`);
  const solved = mine.filter((e) => e.t === "room_solved");
  check("room_solved levels match result.perRoom", solved.every((e) => result.perRoom[e.room as keyof typeof result.perRoom] === e.hintLevel), solved.map((e) => `${e.room}=${e.hintLevel}`).join(" "));
  check("escaped == exit solved", result.escaped === (result.perRoom.exit !== undefined && result.perRoom.exit !== "X"), `escaped=${result.escaped} exit=${result.perRoom.exit}`);

  // 7. Persistence.
  let saved: RunResult | undefined;
  try {
    const all: RunResult[] = JSON.parse(readFileSync("data/runs.json", "utf8"));
    saved = all.find((r) => r.runId === runId);
    check("data/runs.json has the run", !!saved, `${all.length} runs on file`);
    const leaks = findSecrets(readFileSync("data/runs.json", "utf8"));
    check("no secrets in data/runs.json", leaks.length === 0, leaks.join(", "));
  } catch (e: any) {
    check("data/runs.json has the run", false, e.message);
  }
  const lb = await req("GET", "/api/leaderboard");
  const lbRows: any[] = Array.isArray(lb.json) ? lb.json : (lb.json?.runs ?? lb.json?.leaderboard ?? []);
  check("GET /api/leaderboard includes it", lb.status === 200 && lbRows.some((r) => r.runId === runId), `HTTP ${lb.status}, ${lbRows.length} rows`);
  const post = await req("GET", "/api/state");
  check("/api/state after run: over, not starting", post.json?.run?.over === true && !post.json?.starting, `over=${post.json?.run?.over} starting=${post.json?.starting}`);

  // 8. Stripe: the hold was partially captured.
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) check("Stripe PaymentIntent captured <= $5", null, "STRIPE_SECRET_KEY missing");
  else if (!result.paymentIntentId || result.paymentIntentId.startsWith("pi_mock_")) check("Stripe PaymentIntent captured <= $5", false, `paymentIntentId=${result.paymentIntentId}`);
  else {
    try {
      const pi = await new Stripe(key).paymentIntents.retrieve(result.paymentIntentId);
      const expectCancel = result.totalCents === 0;
      const ok = expectCancel ? pi.status === "canceled" : pi.status === "succeeded" && pi.amount_received > 0 && pi.amount_received <= BUDGET_CENTS;
      check("Stripe PaymentIntent captured <= $5", ok, `${pi.id} status=${pi.status} amount=${pi.amount} received=${pi.amount_received} capture_method=${pi.capture_method}`);
      check("captured == result.totalCents", pi.amount_received === result.totalCents, `${pi.amount_received} vs ${result.totalCents}`);
      check("receipt_url in result", expectCancel || !!result.receiptUrl, result.receiptUrl ? "present" : "missing");
      const meta = JSON.stringify(pi.metadata ?? {});
      check("no secrets in Stripe metadata", findSecrets(meta).length === 0, findSecrets(meta).join(", "));
    } catch (e: any) {
      check("Stripe PaymentIntent captured <= $5", false, e.message);
    }
  }
  finishSecretChecks(events, runId);
}

function finishSecretChecks(events: Ev[], runId: string | null) {
  const leaks: string[] = [];
  for (const e of events) {
    const hits = findSecrets(JSON.stringify(e));
    if (hits.length) leaks.push(`${e.t}@${e.runId === runId ? "run" : e.runId}: ${hits.join("/")}`);
  }
  check("no secret-looking strings in SSE events", leaks.length === 0, leaks.slice(0, 5).join("; ") || `${events.length} events scanned`);
  // Agent output (cmd/cmd_result/thought) may legitimately contain hex digests; scan the server-built events.
  const tok = events.filter((e) => !["cmd", "cmd_result", "thought"].includes(e.t) && tokenLeaks(JSON.stringify(e))).map((e) => e.t);
  check("no agent token in server-built SSE events", tok.length === 0, tok.join(", "));
  if (SPAWN) {
    const hits = findSecrets(serverLog);
    check("no secrets in server stdout/stderr", hits.length === 0, hits.join(", "));
  }
}

// ---------- main ----------

const main = QUICK ? quick : full;
main()
  .catch((e) => check("e2e crashed", false, String(e?.stack ?? e)))
  .finally(() => {
    if (childExit && SPAWN) check("server stayed up", false, `${childExit}: ${serverLog.slice(-300)}`);
    stopServer();
    const fails = printTable();
    setTimeout(() => process.exit(fails ? 1 : 0), 300);
  });
