// Builds a house, installs it in the room402 sandbox, and proves every room is solvable from inside.
// Run: npx tsx src/dev/try-house.ts [seed]
import { buildHouse, checkKey } from "../rooms/index.js";
import { applyFolds, render, buildFold } from "../rooms/fold.js";
import { yearsAt, buildYears } from "../rooms/years.js";
import { rng } from "../rng.js";
import { sandbox } from "../sandbox.js";

const seed = Number(process.argv[2] ?? 402);
const results: string[] = [];
const ok = (name: string, pass: boolean, detail: string, t0: number) => {
  process.stderr.write(`[${name}] ${pass}\n`);
  results.push(`${pass ? "PASS" : "FAIL"} ${name} (${Date.now() - t0}ms) ${detail}`);
};

async function main() {
  let t = Date.now();
  const house = buildHouse(seed);
  const again = buildHouse(seed);
  ok("deterministic", house.exitKey === again.exitKey, `exit=${house.exitKey}`, t);

  // Local checks: fold round-trip and years matrix vs naive loop.
  t = Date.now();
  const { room: foldRoom, letters } = buildFold(rng(seed * 4 + 3));
  const dots = String(foldRoom.files["/room/3-folded-note/dots.txt"]).trim().split("\n").map((l) => l.split(",").map(Number) as [number, number]);
  const folds = String(foldRoom.files["/room/3-folded-note/folds.txt"]).trim().split("\n").map((l) => {
    const m = l.match(/fold along ([xy])=(\d+)/)!;
    return { axis: m[1] as "x" | "y", at: Number(m[2]) };
  });
  const set = applyFolds(dots, folds);
  const expected = new Set<string>();
  render(letters).forEach((row, y) => [...row].forEach((ch, x) => ch === "#" && expected.add(`${x},${y}`)));
  const same = set.size === expected.size && [...set].every((p) => expected.has(p));
  ok("fold-local", same, `letters=${letters} dots=${dots.length} folds=${folds.length}`, t);

  t = Date.now();
  const { params } = buildYears(rng(seed * 4 + 2));
  const naive = (n: number) => {
    const { P, A, B, C, D, E, F } = params;
    if (n < 3) return F[n] % P;
    let [a, b, c] = F;
    for (let i = 3n; i <= BigInt(n); i++) [a, b, c] = [b, c, (A * c + B * b + C * a + D * i * i + E) % P];
    return c;
  };
  const smalls = [0, 1, 2, 3, 4, 10, 1000, 54321];
  const yearsOk = smalls.every((n) => yearsAt(params, BigInt(n)) === naive(n));
  ok("years-local", yearsOk, `checked n=${smalls.join(",")}`, t);

  // Live sandbox.
  t = Date.now();
  const box = await sandbox.ready();
  ok("ready", !!box.id, `${box.name} ${box.id}`, t);

  t = Date.now();
  await sandbox.setEgress("open");
  await sandbox.install(house);
  ok("install", true, "uploaded + props up", t);

  t = Date.now();
  await sandbox.setEgress("locked");
  const blocked = await sandbox.exec(`curl -s -o /dev/null -m 5 -w '%{http_code}' https://pypi.org/simple/ || echo BLOCKED`, 20_000);
  ok("egress-locked", /BLOCKED|000/.test(blocked.stdout), `pypi -> ${blocked.stdout.trim()}`, t);

  const [hA, hB, hC, hD] = house.rooms[0].answer!.split("-");
  t = Date.now();
  const a = await sandbox.exec(`for p in $(pgrep -f '[/]opt/[.]house/keeper'); do tr '\\0' '\\n' < /proc/$p/environ | grep HOUSE_SHARD; done`);
  const b = await sandbox.exec(`for hex in $(awk 'NR>1 && $4=="0A" && $2 ~ /^0100007F:/ {split($2,a,":"); print a[2]}' /proc/net/tcp); do curl -s -m 2 127.0.0.1:$((16#$hex))/ 2>/dev/null; done | grep 'shard b'`);
  const c = await sandbox.exec(`find /room -type f -name '* ' -exec cat {} \\;`);
  const d = await sandbox.exec(`zcat /var/log/house/*.gz | grep 'shard d'`);
  const houseOk = a.stdout.includes(hA) && b.stdout.includes(hB) && c.stdout.includes(hC) && d.stdout.includes(hD);
  ok("house-solve", houseOk, `a=${a.stdout.trim()} | b=${b.stdout.trim()} | c=${c.stdout.trim()} | d=${d.stdout.trim()} (localhost while locked)`, t);

  t = Date.now();
  const slowSmall = await sandbox.exec(`cd /room/2-ten-thousand-years && python3 slow.py 54321`);
  const solver = `
import re
src = open('/room/2-ten-thousand-years/slow.py').read()
g = lambda k: int(re.search(r'^' + k + r'\\s*=\\s*(\\d+)', src, re.M).group(1))
P, N = g('P'), g('N')
A, B, C, D, E = map(int, re.search(r'^A, B, C, D, E = (.*)$', src, re.M).group(1).split(','))
F0, F1, F2 = map(int, re.search(r'^F0, F1, F2 = (.*)$', src, re.M).group(1).split(','))
M = [[A,B,C,D,2*D%P,(D+E)%P],[1,0,0,0,0,0],[0,1,0,0,0,0],[0,0,0,1,2,1],[0,0,0,0,1,1],[0,0,0,0,0,1]]
def mul(X,Y): return [[sum(X[i][k]*Y[k][j] for k in range(6))%P for j in range(6)] for i in range(6)]
R = [[int(i==j) for j in range(6)] for i in range(6)]
e = N - 2
while e:
    if e & 1: R = mul(R, M)
    M = mul(M, M); e >>= 1
s = [F2, F1, F0, 4, 2, 1]
print(sum(R[0][k]*s[k] for k in range(6)) % P)
`;
  const y = await sandbox.exec(`python3 - <<'PY'\n${solver}\nPY`);
  const yearsKey = house.rooms[1].answer!;
  ok("years-solve", y.stdout.trim() === yearsKey && slowSmall.stdout.trim() === String(yearsAt(params, 54321n)), `matrix=${y.stdout.trim()} key=${yearsKey} slow(54321) matches TS`, t);

  t = Date.now();
  const foldSolver = `
pts = [tuple(map(int, l.split(','))) for l in open('/room/3-folded-note/dots.txt') if l.strip()]
for l in open('/room/3-folded-note/folds.txt'):
    if not l.strip(): continue
    ax, k = l.strip().split()[-1].split('='); k = int(k)
    pts = [((2*k - x) if ax == 'x' and x > k else x, (2*k - y) if ax == 'y' and y > k else y) for x, y in pts]
s = set(pts); W = max(x for x, _ in s) + 1; H = max(y for _, y in s) + 1
print('\\n'.join(''.join('#' if (x, y) in s else ' ' for x in range(W)) for y in range(H)))
`;
  const f = await sandbox.exec(`python3 - <<'PY'\n${foldSolver}\nPY`);
  const want = render(letters).map((r) => r.replace(/\s+$/, "")).join("\n");
  const got = f.stdout.split("\n").map((r) => r.replace(/\s+$/, "")).join("\n").trim();
  ok("fold-solve", got === want.trim(), `\n${f.stdout}`, t);

  t = Date.now();
  const keysOk =
    checkKey(house, "house", house.rooms[0].answer!.toUpperCase()) &&
    checkKey(house, "years", ` ${yearsKey} `) &&
    checkKey(house, "fold", letters.toLowerCase()) &&
    !checkKey(house, "vault", "1234567") &&
    checkKey(house, "exit", house.exitKey) &&
    !checkKey(house, "exit", "nope");
  ok("checkKey", keysOk, "", t);

  await sandbox.setEgress("open");
  const reopened = await sandbox.exec(`curl -s -o /dev/null -m 6 -w '%{http_code}' https://pypi.org/simple/ || echo BLOCKED`, 20_000);
  results.push(`INFO egress reopened -> ${reopened.stdout.trim()}`);
}

main()
  .catch((e) => results.push(`FAIL fatal ${e?.stack ?? e}`))
  .finally(() => {
    console.log(results.join("\n"));
    process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
  });
