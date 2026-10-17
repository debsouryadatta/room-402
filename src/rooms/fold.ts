import type { Rng } from "../rng.js";
import type { BuiltRoom, RoomDef } from "../types.js";

const DIR = "/room/3-folded-note";

// 5 wide x 6 tall block font. No O/D/I/Q/0/1 (too easy to confuse).
const FONT: Record<string, string[]> = {
  A: [" ### ", "#   #", "#   #", "#####", "#   #", "#   #"],
  B: ["#### ", "#   #", "#### ", "#   #", "#   #", "#### "],
  C: [" ####", "#    ", "#    ", "#    ", "#    ", " ####"],
  E: ["#####", "#    ", "#### ", "#    ", "#    ", "#####"],
  F: ["#####", "#    ", "#### ", "#    ", "#    ", "#    "],
  G: [" ####", "#    ", "#    ", "#  ##", "#   #", " ####"],
  H: ["#   #", "#   #", "#####", "#   #", "#   #", "#   #"],
  J: ["  ###", "    #", "    #", "    #", "#   #", " ### "],
  K: ["#   #", "#  # ", "###  ", "#  # ", "#   #", "#   #"],
  L: ["#    ", "#    ", "#    ", "#    ", "#    ", "#####"],
  M: ["#   #", "## ##", "# # #", "#   #", "#   #", "#   #"],
  N: ["#   #", "##  #", "# # #", "#  ##", "#   #", "#   #"],
  P: ["#### ", "#   #", "#   #", "#### ", "#    ", "#    "],
  R: ["#### ", "#   #", "#   #", "#### ", "#  # ", "#   #"],
  S: [" ####", "#    ", " ### ", "    #", "    #", "#### "],
  T: ["#####", "  #  ", "  #  ", "  #  ", "  #  ", "  #  "],
  U: ["#   #", "#   #", "#   #", "#   #", "#   #", " ### "],
  V: ["#   #", "#   #", "#   #", "#   #", " # # ", "  #  "],
  W: ["#   #", "#   #", "#   #", "# # #", "## ##", "#   #"],
  X: ["#   #", " # # ", "  #  ", "  #  ", " # # ", "#   #"],
  Y: ["#   #", " # # ", "  #  ", "  #  ", "  #  ", "  #  "],
  Z: ["#####", "    #", "   # ", "  #  ", " #   ", "#####"],
};

export type Fold = { axis: "x" | "y"; at: number };

export function render(letters: string): string[] {
  const rows: string[] = [];
  for (let y = 0; y < 6; y++) rows.push([...letters].map((ch) => FONT[ch][y]).join(" "));
  return rows;
}

export function applyFolds(dots: [number, number][], folds: Fold[]): Set<string> {
  let pts = dots.map(([x, y]) => [x, y] as [number, number]);
  for (const f of folds) {
    pts = pts.map(([x, y]) =>
      f.axis === "x" ? [x > f.at ? 2 * f.at - x : x, y] : [x, y > f.at ? 2 * f.at - y : y],
    );
  }
  return new Set(pts.map(([x, y]) => `${x},${y}`));
}

export function buildFold(r: Rng): { room: BuiltRoom; letters: string } {
  const letters = Array.from({ length: 8 }, () => r.pick(Object.keys(FONT))).join("");
  const grid = render(letters);
  let w = grid[0].length;
  let h = grid.length;
  let dots: [number, number][] = [];
  grid.forEach((row, y) => [...row].forEach((ch, x) => ch === "#" && dots.push([x, y])));

  // Unfold: pick a line just past the paper, mirror some dots across it. Folding along it later undoes this.
  const unfolds: Fold[] = [];
  const count = r.int(3, 5);
  for (let i = 0; i < count; i++) {
    const axis: "x" | "y" = i === 0 ? "y" : r.next() < 0.5 ? "x" : "y";
    const size = axis === "x" ? w : h;
    const at = size + r.int(0, 3);
    const next: [number, number][] = [];
    for (const [x, y] of dots) {
      const v = axis === "x" ? x : y;
      const mirror: [number, number] = axis === "x" ? [2 * at - v, y] : [x, 2 * at - v];
      const roll = r.next();
      if (roll < 0.4) next.push([x, y]);
      else if (roll < 0.8) next.push(mirror);
      else next.push([x, y], mirror);
    }
    dots = next;
    unfolds.push({ axis, at });
    if (axis === "x") w = 2 * at + 1;
    else h = 2 * at + 1;
  }
  const folds = [...unfolds].reverse();
  const unique = [...new Map(dots.map((d) => [`${d[0]},${d[1]}`, d])).values()];
  const shuffled = r.shuffle(unique);

  const def: RoomDef = {
    id: "fold",
    title: "Folded Note",
    skill: "spatial reasoning",
    dir: DIR,
    brief: `${DIR}/dots.txt is a sheet of transparent paper with dots; ${DIR}/folds.txt says how to fold it. Fold it and read the 8 capital letters. The key is those letters.`,
    hints: {
      nudge: "Plot it.",
      clue: "Apply the folds in order. For 'fold along x=K', a dot with x > K moves to 2K - x (same idea for y). Then print the remaining dots as a grid of # and read the 8 letters.",
      answer: `The Folded Note key is ${letters}`,
    },
  };

  return {
    room: {
      def,
      files: {
        [`${DIR}/dots.txt`]: shuffled.map(([x, y]) => `${x},${y}`).join("\n") + "\n",
        [`${DIR}/folds.txt`]: folds.map((f) => `fold along ${f.axis}=${f.at}`).join("\n") + "\n",
      },
      answer: letters,
    },
    letters,
  };
}
