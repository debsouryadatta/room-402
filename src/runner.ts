import "./env.js";
import { runAgent } from "./agent.js";
import { emit } from "./bus.js";
import { createRun, currentRun } from "./game.js";
import { buildHouse } from "./rooms/index.js";
import { sandbox } from "./sandbox.js";

export const MODELS = [
  { id: "anthropic/claude-haiku-5.5", label: "Claude Haiku 5.5" },
  { id: "openai/gpt-6-luna", label: "GPT-6 Luna" },
];

let busy = false; // one sandbox => one run at a time

export function isBusy() {
  const cur = currentRun();
  return busy || (!!cur && !cur.isOver());
}

export async function startRun({ model, seed }: { model: string; seed?: number }): Promise<{ runId: string }> {
  if (isBusy()) throw new Error("A run is already in progress; wait for it to finish.");
  busy = true;
  const s = Number.isFinite(seed) ? Number(seed) : Math.floor(Math.random() * 1_000_000);
  try {
    const house = buildHouse(s);
    await sandbox.ready();
    await sandbox.setEgress("open");
    await sandbox.install(house);
    await sandbox.setEgress("locked");
    const run = await createRun({ model, seed: s, house });

    void (async () => {
      try {
        await runAgent(run, house, model);
      } catch (e: any) {
        emit(run.id, { t: "error", message: `agent crashed: ${String(e?.message ?? e).slice(0, 300)}` });
      } finally {
        try {
          if (!run.isOver()) await run.finish("agent_stopped");
        } catch (e: any) {
          emit(run.id, { t: "error", message: `finish failed: ${String(e?.message ?? e).slice(0, 300)}` });
        }
        busy = false;
      }
    })();

    return { runId: run.id };
  } catch (e: any) {
    busy = false;
    emit(`setup-${s}`, { t: "error", message: `run setup failed: ${String(e?.message ?? e).slice(0, 300)}` });
    throw e;
  }
}
