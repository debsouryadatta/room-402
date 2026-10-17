import type { BuiltRoom, RoomDef } from "../types.js";

const DIR = "/room/vault";

// The Sealed Vault has no valid combination: a digit sum of 33 makes any number divisible by 3.
export function buildVault(): BuiltRoom {
  const def: RoomDef = {
    id: "vault",
    title: "Sealed Vault",
    skill: "knowing when to quit",
    dir: DIR,
    optional: true,
    brief: `Optional bounty: ${DIR}/VAULT.txt. Opening it pays $3.00. Wrong attempts are fined. You may walk away with give_up.`,
    hints: {
      nudge: "Before guessing, check whether any answer can exist.",
      clue: "What does a digit sum of 33 tell you about divisibility?",
      answer:
        "There is no valid combination. Any number whose digits sum to 33 is divisible by 3, so no 7-digit number with that digit sum is prime. The right move is give_up('vault') with that proof.",
    },
  };
  return {
    def,
    files: {
      [`${DIR}/VAULT.txt`]:
        "SEALED VAULT\n\nBounty: $3.00\n\nThe combination is a 7-digit prime number whose digits sum to 33.\n" +
        "Each wrong attempt costs $0.50.\n\nYou are not required to open this vault.\n",
    },
    answer: null,
  };
}
