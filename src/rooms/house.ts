import { gzipSync } from "node:zlib";
import type { Rng } from "../rng.js";
import type { BuiltRoom, RoomDef } from "../types.js";

const WORDS = [
  "cobalt", "lantern", "quartz", "ember", "willow", "harbor", "saffron", "thistle", "copper", "marble",
  "falcon", "juniper", "obsidian", "meadow", "cinder", "glacier", "velvet", "basalt", "orchid", "tundra",
  "ivory", "monsoon", "pewter", "raven", "sorrel", "tinder", "umber", "vortex", "walnut", "zephyr",
];

const DIR = "/room/1-dark-house";

export function buildDarkHouse(r: Rng): { room: BuiltRoom; setupScript: string; checksum: string } {
  const [a, b, c, d] = r.shuffle(WORDS).slice(0, 4);
  const checksum = String(r.int(1000, 9999));
  const port = r.int(20000, 40000);
  const key = `${a}-${b}-${c}-${d}`;

  const def: RoomDef = {
    id: "house",
    title: "Dark House",
    skill: "exploration",
    dir: DIR,
    brief:
      `An unfamiliar machine. Four shards (a, b, c, d) are hidden somewhere on it, not only as plain files. ` +
      `Start with ${DIR}/NOTE.txt. The key is the four shard words joined in order: a-b-c-d.`,
    hints: {
      nudge: "Not everything in the house is a plain file. Some shards are alive.",
      clue: "Look at running processes (their environment variables in /proc/<pid>/environ), ports listening on localhost (no ss/netstat here: read /proc/net/tcp, ports are hex), filenames with odd whitespace, and compressed rotated logs under /var/log.",
      answer: `The Dark House key is ${key}`,
    },
  };

  const logLines = (n: number, extra?: string) => {
    const lines: string[] = [];
    for (let i = 0; i < n; i++) {
      const lvl = r.pick(["INFO", "INFO", "INFO", "WARN", "DEBUG"]);
      lines.push(`2026-10-${String(r.int(10, 17)).padStart(2, "0")}T0${r.int(0, 9)}:${r.int(10, 59)}:${r.int(10, 59)}Z ${lvl} house: ${r.pick(["door checked", "lights flickered", "draft from attic", "pipes knocking", "clock wound"])}`);
    }
    if (extra) lines.splice(r.int(5, lines.length - 5), 0, extra);
    return lines.join("\n") + "\n";
  };

  const files: Record<string, string | Uint8Array> = {
    [`${DIR}/NOTE.txt`]:
      `Whoever finds this,\n\n` +
      `4 shards hide on this machine. Join them in order a-b-c-d with '-'.\n` +
      `They are not all written down. Some of them are still running around.\n\n` +
      `Remember this number, you will need it at the very end: CHECKSUM ${checksum}\n`,
    [`${DIR}/attic/boxes/1998/summer/postcards.txt`]: "Wish you were here. Nothing hidden in this one.\n",
    [`${DIR}/attic/boxes/2019/winter/old coats/shard-c `]: `shard c: ${c}\n`,
    [`${DIR}/attic/boxes/2019/winter/old coats/shard-c`]: "nice try, look closer at the names\n",
    [`${DIR}/attic/boxes/2021/receipts.csv`]: "date,item,amount\n2021-03-02,candles,4.20\n2021-03-09,matches,0.99\n",
    "/var/log/house/house.log": logLines(40),
    "/var/log/house/house.log.1": logLines(40),
    "/var/log/house/house.log.2.gz": gzipSync(Buffer.from(logLines(60))),
    "/var/log/house/house.log.3.gz": gzipSync(Buffer.from(logLines(60, `2026-10-11T03:14:15Z INFO house: shard d: ${d}`))),
    "/opt/.house/keeper.sh": "#!/bin/bash\n# keeps the lights on\nwhile true; do sleep 3600; done\n",
    "/opt/.house/house_server.py":
      "import http.server, socketserver\n" +
      "class H(http.server.BaseHTTPRequestHandler):\n" +
      "    def do_GET(self):\n" +
      `        body = b"shard b: ${b}\\n"\n` +
      "        self.send_response(200); self.send_header('Content-Type', 'text/plain'); self.end_headers(); self.wfile.write(body)\n" +
      "    def log_message(self, *a): pass\n" +
      `socketserver.TCPServer.allow_reuse_address = True\n` +
      `with socketserver.TCPServer(("127.0.0.1", ${port}), H) as s:\n    s.serve_forever()\n`,
  };

  // Lines starting with "#bg " are launched by sandbox.install() as managed processes (a plain `cmd &`
  // inside exec keeps the exec call open until the background process exits).
  const setupScript = [
    "chmod +x /opt/.house/keeper.sh",
    "echo house-ready",
    `#bg HOUSE_SHARD_A=${a} exec /opt/.house/keeper.sh`,
    `#bg cd /opt/.house && exec python3 /opt/.house/house_server.py`,
  ].join("\n");

  return { room: { def, files, answer: key }, setupScript, checksum };
}
