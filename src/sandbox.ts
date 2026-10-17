import { createClient, type Sandbox } from "@nodeops-createos/sandbox";
import type { BuiltHouse, ExecResult, SandboxApi } from "./types.js";

try {
  process.loadEnvFile(".env");
} catch {}

const BOX_NAME = "room402";
const BASE_URL = process.env.CREATEOS_SANDBOX_BASE_URL || "https://api-eu.sb.createos.sh";
const LOCKED_RULES = ["127.0.0.1:1"]; // any rule => deny-by-default; this one matches nothing useful

let client: ReturnType<typeof createClient> | null = null;
let box: Sandbox | null = null;

function api() {
  if (!client) {
    const apiKey = process.env.CREATEOS_PROJECT_API_KEY || process.env.CREATEOS_API_KEY || process.env.CREATEOS_SANDBOX_API_KEY;
    if (!apiKey) throw new Error("No CreateOS API key (CREATEOS_PROJECT_API_KEY) in env");
    client = createClient({ apiKey, baseUrl: BASE_URL });
  }
  return client;
}

async function getBox(): Promise<Sandbox> {
  if (box) return box;
  const existing = (await api().listSandboxes()).find(
    (x) => x.name === BOX_NAME && !["destroyed", "destroying", "failed"].includes(x.status),
  );
  if (existing) {
    box = existing;
    if (box.status === "paused") {
      await box.resume();
      await box.waitUntilRunning({ timeoutMs: 60_000 });
    }
  } else {
    box = await api().createSandbox({ name: BOX_NAME, shape: "s-1vcpu-1gb", rootfs: "devbox:1", ingress_enabled: true });
  }
  return box;
}

async function exec(cmd: string, timeoutMs = 60_000): Promise<ExecResult> {
  const started = Date.now();
  try {
    const sb = await getBox();
    // The SDK timeout only covers the request headers, so bound the command inside the VM
    // (coreutils timeout, then SIGKILL) and also race a hard client-side deadline.
    const secs = Math.max(5, Math.floor(timeoutMs / 1000) - 3);
    const call = sb.runCommand("timeout", ["-k", "3", String(secs), "bash", "-lc", cmd], { timeoutMs, stdin: "" });
    const deadline = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`command timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs + 5_000),
    );
    const r = await Promise.race([call, deadline]);
    const res = r.result;
    if (res.exit_code === 124 || res.exit_code === 137) res.stderr = `${res.stderr ?? ""}\n[timed out after ${secs}s: command killed]`;
    return {
      stdout: res.stdout ?? "",
      stderr: (res.stderr ?? "") + (res.error ? `\n${res.error}` : ""),
      exit_code: typeof res.exit_code === "number" ? res.exit_code : -1,
      ms: Date.now() - started,
    };
  } catch (e: any) {
    return { stdout: "", stderr: String(e?.message ?? e), exit_code: -1, ms: Date.now() - started };
  }
}

async function install(house: BuiltHouse) {
  const sb = await getBox();
  const wipe = await exec(
    "pkill -f '[/]opt/[.]house/'; pkill -f '[h]ouse_server'; pkill -f '[h]ttp.server'; sleep 0.3; " +
      "pkill -x sleep; pkill -f '[s]low.py'; pkill -9 -f '[p]ython3'; pkill -9 -x grep; pkill -9 -x find; " +
      "rm -rf /room /var/log/house /opt/.house /tmp/* /tmp/.[!.]* /var/tmp/* /root/*.py /root/*.txt /root/*.out 2>/dev/null; " +
      "mkdir -p /room; echo wiped",
    30_000,
  );
  if (!wipe.stdout.includes("wiped")) throw new Error(`wipe failed: ${wipe.stderr}`);

  const files = house.rooms.flatMap((r) => Object.entries(r.files));
  const dirs = [...new Set(files.map(([p]) => p.slice(0, p.lastIndexOf("/")) || "/"))];
  const mk = await exec(`mkdir -p ${dirs.map((d) => `'${d.replace(/'/g, "'\\''")}'`).join(" ")} && echo ok`, 30_000);
  if (!mk.stdout.includes("ok")) throw new Error(`mkdir failed: ${mk.stderr}`);

  const dbg = (m: string) => process.env.R402_DEBUG && process.stderr.write(`[install] ${m}\n`);
  dbg(`wiped, dirs ok, uploading ${files.length}`);
  for (const [path, content] of files) {
    dbg(`upload ${JSON.stringify(path)}`);
    const body = typeof content === "string" ? content : new Uint8Array(content);
    await sb.files.upload(path, body as any);
  }

  // Background props must be managed processes: exec waits for every process it spawned.
  const lines = house.setupScript.split("\n");
  const script = lines.filter((l) => !l.startsWith("#bg ")).join("\n");
  const background = lines.filter((l) => l.startsWith("#bg ")).map((l) => l.slice(4));
  dbg("setup");
  const setup = await exec(script, 60_000);
  dbg(`setup exit=${setup.exit_code}`);
  if (setup.exit_code !== 0) throw new Error(`setup failed (${setup.exit_code}): ${setup.stderr.slice(0, 400)}`);
  for (const cmd of background) {
    dbg(`bg ${cmd.replace(/=\S+/, "=…")}`);
    await sb.processes.create({ cmd: "bash", args: ["-c", cmd], cwd: "/" });
  }
  const verify = await exec(`sleep 1; pgrep -f '[/]opt/[.]house/keeper' >/dev/null && pgrep -f '[h]ouse_server' >/dev/null && echo props-up`, 20_000);
  if (!verify.stdout.includes("props-up")) throw new Error(`props not running: ${verify.stdout} ${verify.stderr}`);
}

async function setEgress(mode: "open" | "locked") {
  const sb = await getBox();
  await sb.setEgress(mode === "locked" ? LOCKED_RULES : null);
}

export const sandbox: SandboxApi = {
  async ready() {
    const sb = await getBox();
    let previewUrl: string | undefined;
    try {
      previewUrl = sb.data.ingress_url_template ? sb.previewUrl(8080) : undefined;
    } catch {}
    return { name: sb.name ?? BOX_NAME, id: sb.id, previewUrl };
  },
  exec,
  install,
  setEgress,
};
