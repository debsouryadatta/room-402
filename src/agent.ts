import { BASE_URL } from "./env.js";
import OpenAI from "openai";
import { emit } from "./bus.js";
import { kickoffMessage, systemPrompt } from "./prompt.js";
import { RUN_TIME_LIMIT_MS, RUN_TURN_LIMIT, type BuiltHouse, type SandboxApi } from "./types.js";

// The minimum the loop needs from a game run (src/game.ts Run satisfies this).
export interface AgentRun {
  agentToken?: string;
  countTurn?(): void;
  id: string;
  isOver(): boolean;
}

export interface AgentOptions {
  baseUrl?: string; // Hint Shop / Door server; defaults to the local server
  sandbox?: SandboxApi; // injected in tests
  maxTurns?: number;
  kickoff?: string;
  system?: string;
}

export interface AgentStats {
  turns: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  stopReason: string;
}

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;


const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  tool("run_command", "Run a bash command inside the room (the Linux microVM). Returns stdout, stderr and exit_code. 60 s timeout.", {
    cmd: { type: "string", description: "bash command line" },
  }),
  tool("get_hint", "Ask the Hint Shop for a hint. Normally answers HTTP 402 Payment Required with a price and invoice_id; call pay(invoice_id) to unlock.", {
    room: { type: "string", description: "room id, e.g. house, years, fold, vault" },
    tier: { type: "string", enum: ["nudge", "clue", "answer"] },
  }),
  tool("pay", "Pay a Hint Shop invoice from your wallet (test-mode card hold). Returns the unlocked hint.", {
    invoice_id: { type: "string" },
  }),
  tool("open_door", "Try a key on a door. Wrong keys cost a fine. Use room 'exit' with the full exit key to escape.", {
    room: { type: "string" },
    key: { type: "string" },
  }),
  tool("request_approval", "Ask the human supervisor to approve spending above your free limit. Blocks until they decide (up to 2 minutes).", {
    amount_usd: { type: "number", description: "extra amount you want to be allowed to spend" },
    reason: { type: "string" },
  }),
  tool("give_up", "Forfeit a room (e.g. when you have proven it is impossible). Give a reason.", {
    room: { type: "string" },
    reason: { type: "string" },
  }),
];

function tool(name: string, description: string, properties: Record<string, unknown>): OpenAI.Chat.Completions.ChatCompletionTool {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required: Object.keys(properties) } } };
}

function clip(s: string, max: number) {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.7);
  return `${s.slice(0, head)}\n...[${s.length - max} chars trimmed]...\n${s.slice(s.length - (max - head))}`;
}

let runToken = "";

async function http(method: "GET" | "POST", url: string, body?: unknown) {
  try {
    const res = await fetch(url, {
      method,
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...(runToken ? { "x-run-token": runToken } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, headers: res.headers, body: json };
  } catch (e: any) {
    return { status: 0, headers: new Headers(), body: { error: `network error: ${e?.message ?? e}` } };
  }
}

export async function runAgent(run: AgentRun, house: BuiltHouse, model: string, opts: AgentOptions = {}): Promise<AgentStats> {
  const base = opts.baseUrl ?? BASE_URL;
  const sb = opts.sandbox ?? (await import("./sandbox.js")).sandbox;
  const maxTurns = opts.maxTurns ?? RUN_TURN_LIMIT;
  const client = new OpenAI({ apiKey: process.env.OPENROUTER_API_KEY, baseURL: "https://openrouter.ai/api/v1" });
  const runQ = `run=${encodeURIComponent(run.id)}`;
  runToken = run.agentToken ?? "";
  const started = Date.now();

  const messages: Msg[] = [
    { role: "system", content: opts.system ?? systemPrompt(house) },
    { role: "user", content: opts.kickoff ?? kickoffMessage(house) },
  ];
  const stats: AgentStats = { turns: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, stopReason: "" };

  async function callTool(name: string, args: any): Promise<string> {
    switch (name) {
      case "run_command": {
        const cmd = String(args.cmd ?? "");
        emit(run.id, { t: "cmd", cmd });
        const r = await sb.exec(cmd, 60_000);
        emit(run.id, { t: "cmd_result", stdout: clip(r.stdout, 4000), stderr: clip(r.stderr, 4000), exit_code: r.exit_code, ms: r.ms });
        return JSON.stringify({ exit_code: r.exit_code, stdout: clip(r.stdout, 3500), stderr: clip(r.stderr, 3500) });
      }
      case "get_hint": {
        const r = await http("GET", `${base}/hint/${encodeURIComponent(String(args.room))}/${encodeURIComponent(String(args.tier))}?${runQ}`);
        return JSON.stringify({ http_status: r.status, www_authenticate: r.headers.get("www-authenticate") ?? undefined, body: r.body });
      }
      case "pay": {
        const r = await http("POST", `${base}/pay?${runQ}`, { run: run.id, invoice_id: String(args.invoice_id) });
        return JSON.stringify({ http_status: r.status, body: r.body });
      }
      case "open_door": {
        const r = await http("POST", `${base}/door?${runQ}`, { run: run.id, room: String(args.room), key: String(args.key) });
        return JSON.stringify({ http_status: r.status, body: r.body });
      }
      case "request_approval": {
        const amountUsd = Number(args.amount_usd) || 0;
        const r = await http("POST", `${base}/approval?${runQ}`, {
          run: run.id,
          amount_cents: Math.round(amountUsd * 100),
          amount_usd: amountUsd,
          reason: String(args.reason ?? ""),
        });
        const id = (r.body as any)?.id ?? (r.body as any)?.approval_id ?? (r.body as any)?.approvalId;
        if (!id) return JSON.stringify({ http_status: r.status, body: r.body });
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline && !run.isOver()) {
          await new Promise((res) => setTimeout(res, 2000));
          const s = await http("GET", `${base}/approval/${encodeURIComponent(id)}?${runQ}`);
          const b: any = s.body;
          const status = b?.status ?? (b?.approved === true ? "approved" : b?.approved === false ? "denied" : "pending");
          if (status === "approved" || status === "denied") return JSON.stringify({ approval_id: id, decision: status });
        }
        return JSON.stringify({ approval_id: id, decision: "timeout", note: "No decision within 2 minutes; treat as not approved." });
      }
      case "give_up": {
        const r = await http("POST", `${base}/giveup?${runQ}`, { run: run.id, room: String(args.room), reason: String(args.reason ?? "") });
        return JSON.stringify({ http_status: r.status, body: r.body });
      }
      default:
        return JSON.stringify({ error: `unknown tool ${name}` });
    }
  }

  async function complete() {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await client.chat.completions.create({
          model,
          messages,
          tools: TOOLS,
          tool_choice: "auto",
          max_tokens: 3000,
          usage: { include: true },
        } as any);
      } catch (e: any) {
        lastErr = e;
        if (attempt < 2) await new Promise((r) => setTimeout(r, attempt === 0 ? 1500 : 4000));
      }
    }
    throw lastErr;
  }

  function compress() {
    if (messages.length <= 60) return;
    const keepFrom = messages.length - 20;
    for (let i = 2; i < keepFrom; i++) {
      const m = messages[i] as any;
      if (m.role === "tool" && m.content !== "[trimmed]") m.content = "[trimmed]";
    }
  }

  let idle = 0;
  while (true) {
    if (run.isOver()) { stats.stopReason = "run_over"; break; }
    if (stats.turns >= maxTurns) { stats.stopReason = "turn_limit"; break; }
    if (Date.now() - started > RUN_TIME_LIMIT_MS) { stats.stopReason = "time_limit"; break; }
    compress();

    let res: any;
    try {
      res = await complete();
    } catch (e: any) {
      emit(run.id, { t: "error", message: `model error: ${e?.status ?? ""} ${String(e?.message ?? e).slice(0, 300)}` });
      stats.stopReason = "model_error";
      break;
    }
    stats.turns++;
    run.countTurn?.();
    const u = res.usage ?? {};
    stats.promptTokens += u.prompt_tokens ?? 0;
    stats.completionTokens += u.completion_tokens ?? 0;
    stats.costUsd += Number(u.cost ?? 0);

    const msg = res.choices?.[0]?.message;
    if (!msg) {
      emit(run.id, { t: "error", message: `empty model response: ${JSON.stringify(res).slice(0, 200)}` });
      stats.stopReason = "empty_response";
      break;
    }
    const text = typeof msg.content === "string" ? msg.content.trim() : "";
    if (text) emit(run.id, { t: "thought", text: text.slice(0, 600) });

    const calls = msg.tool_calls ?? [];
    messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: calls.length ? calls : undefined } as Msg);

    if (!calls.length) {
      idle++;
      if (idle >= 2) { stats.stopReason = "no_tool_calls"; break; }
      messages.push({ role: "user", content: "Continue. Use tools." });
      continue;
    }
    idle = 0;

    for (const c of calls) {
      let args: any = {};
      let out: string;
      try {
        args = JSON.parse(c.function?.arguments || "{}");
        out = await callTool(c.function?.name, args);
      } catch (e: any) {
        out = JSON.stringify({ error: `bad tool call: ${String(e?.message ?? e).slice(0, 200)}` });
      }
      messages.push({ role: "tool", tool_call_id: c.id, content: out });
      if (run.isOver()) break;
    }
  }
  return stats;
}
