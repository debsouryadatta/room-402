import { EventEmitter } from "node:events";
import type { GameEvent } from "./types.js";

type Payload = GameEvent extends infer E ? (E extends GameEvent ? Omit<E, "runId" | "ts"> : never) : never;

// In-process event bus. src/server.ts streams it to the spectator page over SSE.
const emitter = new EventEmitter();
emitter.setMaxListeners(100);
const history: GameEvent[] = []; // replayed to spectators who connect mid-run

export function emit(runId: string, e: Payload) {
  const ev = { ...e, runId, ts: Date.now() } as GameEvent;
  history.push(ev);
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
