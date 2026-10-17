import { rng } from "../rng.js";
import type { BuiltHouse, RoomId } from "../types.js";
import { buildDarkHouse } from "./house.js";
import { buildYears } from "./years.js";
import { buildFold } from "./fold.js";
import { buildVault } from "./vault.js";

export const ROOM_ORDER: RoomId[] = ["house", "years", "fold", "vault"];

export function buildHouse(seed: number): BuiltHouse {
  // One generator per room, so changing one room never reshuffles another.
  const house = buildDarkHouse(rng(seed * 4 + 1));
  const years = buildYears(rng(seed * 4 + 2));
  const fold = buildFold(rng(seed * 4 + 3));
  const vault = buildVault();

  const exitKey = `${house.room.answer}-${years.room.answer}-${fold.room.answer}-${house.checksum}`;
  house.room.files["/room/EXIT.txt"] =
    "THE EXIT\n\nThe way out opens with one key:\n\n" +
    "  <Dark House key>-<Ten Thousand Years key>-<Folded Note key>-<CHECKSUM from the Dark House note>\n\n" +
    "Shape: word-word-word-word-<number>-<LETTERS>-<4 digits>\n";
  house.room.files["/room/README.txt"] =
    "ROOM 402\n\nThe only way out is code. Help costs money.\n\n" +
    "  1-dark-house/           exploration\n  2-ten-thousand-years/   efficiency\n  3-folded-note/          spatial\n" +
    "  vault/                  optional bounty\n  EXIT.txt                how to leave\n";

  return {
    seed,
    rooms: [house.room, years.room, fold.room, vault],
    setupScript: house.setupScript,
    checksum: house.checksum,
    exitKey,
  };
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ").replace(/\s*-\s*/g, "-");

export function checkKey(house: BuiltHouse, room: RoomId, key: string): boolean {
  if (room === "vault") return false;
  if (room === "exit") return norm(key) === norm(house.exitKey);
  const r = house.rooms.find((x) => x.def.id === room);
  if (!r || r.answer === null) return false;
  return norm(key) === norm(r.answer);
}
