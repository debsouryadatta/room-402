import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import type { GameEvent } from "./types.js";

type Payload = GameEvent extends infer E ? (E extends GameEvent ? Omit<E, "runId" | "ts"> : never) : never;

// In-process event bus. src/server.ts streams it to the spectator page over SSE.
const emitter = new EventEmitter();
emitter.setMaxListeners(100);
const history: GameEvent[] = []; // replayed to spectators who connect mid-run

export function emit(runId: string, e: Payload) {
  const ev = { ...e, runId, ts: Date.now() } as GameEvent;
  history.push(ev);
  persist(ev);
  if (history.length > 2000) history.splice(0, history.length - 2000);
  emitter.emit("event", ev);
}

export function subscribe(fn: (e: GameEvent) => void) {
  emitter.on("event", fn);
  return () => emitter.off("event", fn);
}

export function recent(runId?: string) {
  return runId ? history.filter((e) => e.runId === runId) : [...history];
}

// Every run's events are kept on disk (minus clock ticks) so past runs can be opened in History.
const EVENTS_DIR = "data/events";
let dirReady = false;
function persist(ev: GameEvent) {
  if (ev.t === "tick" || !/^[\w-]+$/.test(ev.runId)) return;
  try {
    if (!dirReady) mkdirSync(EVENTS_DIR, { recursive: true }), (dirReady = true);
    appendFileSync(`${EVENTS_DIR}/${ev.runId}.jsonl`, JSON.stringify(ev) + "\n");
  } catch {
    // history is best-effort; never break a live run over it
  }
}

export function runEvents(runId: string): GameEvent[] {
  if (!/^[\w-]+$/.test(runId)) return [];
  try {
    return readFileSync(`${EVENTS_DIR}/${runId}.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return recent(runId).filter((e) => e.t !== "tick");
  }
}
