import type { Rng } from "../rng.js";
import type { BuiltRoom, RoomDef } from "../types.js";

const DIR = "/room/2-ten-thousand-years";

export interface YearsParams {
  P: bigint;
  A: bigint; B: bigint; C: bigint; D: bigint; E: bigint;
  F: [bigint, bigint, bigint]; // f(0), f(1), f(2)
  N: bigint;
}

function isPrime(n: number) {
  if (n < 2 || n % 2 === 0) return n === 2;
  for (let i = 3; i * i <= n; i += 2) if (n % i === 0) return false;
  return true;
}

type Mat = bigint[][];
const mul = (X: Mat, Y: Mat, P: bigint): Mat =>
  X.map((row) => Y[0].map((_, j) => row.reduce((s, x, k) => (s + x * Y[k][j]) % P, 0n)));

// f(n) = A f(n-1) + B f(n-2) + C f(n-3) + D n^2 + E (mod P), via a 6x6 transition on [f(n), f(n-1), f(n-2), n^2, n, 1].
export function yearsAt(p: YearsParams, n: bigint): bigint {
  const { P, A, B, C, D, E, F } = p;
  if (n < 3n) return F[Number(n)] % P;
  let M: Mat = [
    [A, B, C, D, (2n * D) % P, (D + E) % P],
    [1n, 0n, 0n, 0n, 0n, 0n],
    [0n, 1n, 0n, 0n, 0n, 0n],
    [0n, 0n, 0n, 1n, 2n, 1n],
    [0n, 0n, 0n, 0n, 1n, 1n],
    [0n, 0n, 0n, 0n, 0n, 1n],
  ];
  let R: Mat = M.map((row, i) => row.map((_, j) => (i === j ? 1n : 0n)));
  let e = n - 2n;
  while (e > 0n) {
    if (e & 1n) R = mul(R, M, P);
    M = mul(M, M, P);
    e >>= 1n;
  }
  const s = [F[2], F[1], F[0], 4n, 2n, 1n];
  return R[0].reduce((acc, x, k) => (acc + x * s[k]) % P, 0n);
}

export function buildYears(r: Rng): { room: BuiltRoom; params: YearsParams } {
  let p = r.int(900_000_000, 999_999_999) | 1;
  while (!isPrime(p)) p += 2;
  const params: YearsParams = {
    P: BigInt(p),
    A: BigInt(r.int(2, 97)), B: BigInt(r.int(2, 97)), C: BigInt(r.int(2, 97)),
    D: BigInt(r.int(2, 97)), E: BigInt(r.int(2, 97)),
    F: [BigInt(r.int(1, 999)), BigInt(r.int(1, 999)), BigInt(r.int(1, 999))],
    N: 10n ** 18n + BigInt(r.int(1, 999_999)),
  };
  const key = String(yearsAt(params, params.N));

  const slow = `# Ten Thousand Years
# Computes f(N) for the recurrence below. It is correct. It is also slow.
# ETA on this CPU: ~31 million years. The Door for this room wants f(N) as a decimal integer.
#
#   f(n) = A*f(n-1) + B*f(n-2) + C*f(n-3) + D*n^2 + E   (mod P),  for n >= 3
#
# Usage: python3 slow.py [n]     (n defaults to N; try small n first)
import sys

P = ${params.P}
A, B, C, D, E = ${params.A}, ${params.B}, ${params.C}, ${params.D}, ${params.E}
F0, F1, F2 = ${params.F[0]}, ${params.F[1]}, ${params.F[2]}
N = ${params.N}

def f(n):
    if n < 3:
        return [F0, F1, F2][n] % P
    a, b, c = F0, F1, F2  # f(i-3), f(i-2), f(i-1)
    for i in range(3, n + 1):
        a, b, c = b, c, (A * c + B * b + C * a + D * i * i + E) % P
    return c

if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else N
    print(f(n))
`;

  const def: RoomDef = {
    id: "years",
    title: "Ten Thousand Years",
    skill: "efficiency",
    dir: DIR,
    brief: `${DIR}/slow.py prints the key, eventually. It is correct but would take ~31 million years. The key is f(N) as a decimal integer.`,
    hints: {
      nudge: "Time slow.py at a few small n (it takes an argument) and extrapolate. You need a different algorithm, not a faster computer.",
      clue: "It is a linear recurrence with a polynomial term. Track the state [f(n), f(n-1), f(n-2), n^2, n, 1], build the 6x6 transition matrix, and raise it to the power N-2 by repeated squaring, mod P. Check against slow.py for small n.",
      answer: `The Ten Thousand Years key is ${key}`,
    },
  };

  return {
    room: { def, files: { [`${DIR}/slow.py`]: slow, [`${DIR}/README.txt`]: "The Door for this room wants f(N) from slow.py, as a decimal integer.\n" }, answer: key },
    params,
  };
}
