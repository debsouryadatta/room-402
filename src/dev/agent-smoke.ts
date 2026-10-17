// Smoke test for src/agent.ts: real OpenRouter model, fake sandbox (ls/cat/pwd/echo only, in a temp dir)
// and a fake Hint Shop/Door server that speaks real HTTP 402. Run: npx tsx src/dev/agent-smoke.ts
import "../env.js";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../agent.js";
import { subscribe } from "../bus.js";
import { systemPrompt } from "../prompt.js";
import type { BuiltHouse, ExecResult, SandboxApi } from "../types.js";

const dir = mkdtempSync(join(tmpdir(), "r402-smoke-"));
writeFileSync(join(dir, "key.txt"), "PLUM-7\n");
writeFileSync(join(dir, "NOTE.txt"), "Buy a nudge first. The door key is somewhere in this directory.\n");

const fakeSandbox: SandboxApi = {
  async ready() { return { name: "fake", id: "fake" }; },
  async setEgress() {},
  async install() {},
  exec(cmd: string): Promise<ExecResult> {
    const t = Date.now();
    if (!/^\s*(ls|cat|pwd|echo)\b[^;&|`$()<>]*$/.test(cmd))
      return Promise.resolve({ stdout: "", stderr: "smoke-test sandbox only allows ls/cat/pwd/echo", exit_code: 1, ms: 0 });
    return new Promise((res) =>
      execFile("bash", ["-c", cmd], { cwd: dir, timeout: 10_000 }, (err, stdout, stderr) =>
        res({ stdout, stderr, exit_code: err ? Number((err as any).code) || 1 : 0, ms: Date.now() - t })),
    );
  },
};

let over = false;
const invoices = new Map<string, boolean>();
const log: string[] = [];
const srv = createServer((req, res) => {
  const url = new URL(req.url!, "http://x");
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = (code: number, obj: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(code, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(obj));
    };
    const b = body ? JSON.parse(body) : {};
    log.push(`${req.method} ${url.pathname} ${body}`);
    if (req.method === "GET" && url.pathname.startsWith("/hint/")) {
      const id = "inv_" + Math.random().toString(36).slice(2, 8);
      invoices.set(id, false);
      return json(402, { error: "payment_required", room: "house", tier: "nudge", price_usd: "0.50", price_cents: 50, invoice_id: id, pay_with: "POST /pay {invoice_id}" },
        { "www-authenticate": `Payment realm="room402", invoice_id="${id}", amount="0.50", currency="usd"` });
    }
    if (url.pathname === "/pay") {
      if (!invoices.has(b.invoice_id)) return json(404, { ok: false, error: "unknown invoice" });
      invoices.set(b.invoice_id, true);
      return json(200, { ok: true, invoice_id: b.invoice_id, charged_cents: 50, spent_cents: 50, remaining_cents: 450, hint: "The key is in key.txt." });
    }
    if (url.pathname === "/door") {
      const ok = String(b.key).trim() === "PLUM-7";
      if (ok) over = true;
      return json(200, { ok, message: ok ? "Door opens." : "Wrong key.", fine_cents: ok ? 0 : 50 });
    }
    if (url.pathname === "/giveup") { over = true; return json(200, { ok: true }); }
    return json(404, { error: "not found" });
  });
});
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
const port = (srv.address() as any).port;

const house = {
  seed: 1, setupScript: "", checksum: "0", exitKey: "x",
  rooms: [{ def: { id: "house", title: "Smoke Room", skill: "test", brief: "Find the key.", dir, hints: { nudge: "", clue: "", answer: "" } }, files: {}, answer: "PLUM-7" }],
} as BuiltHouse;
console.log("systemPrompt chars:", systemPrompt(house).length);

subscribe((e) => {
  const { runId, ts, t, ...rest } = e as any;
  console.log(`  [${t}]`, JSON.stringify(rest).slice(0, 180));
});

const stats = await runAgent({ id: "smoke-1", isOver: () => over }, house, process.argv[2] || "anthropic/claude-haiku-5.5", {
  baseUrl: `http://127.0.0.1:${port}`,
  sandbox: fakeSandbox,
  maxTurns: 10,
  system: "You are in a tiny test room. Tools: run_command (only ls/cat/pwd/echo work), get_hint, pay, open_door. Be brief.",
  kickoff: `Step 1: call get_hint(room="house", tier="nudge"); it will answer HTTP 402 with an invoice_id. Step 2: pay that invoice. Step 3: use the hint, read the key from ${dir}, and open_door(room="house", key=...).`,
});
console.log("server log:\n  " + log.join("\n  "));
console.log("stats:", JSON.stringify(stats), "escaped:", over);
srv.close();
