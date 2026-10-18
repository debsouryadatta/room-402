# Room 402: QA report

Updated 05:15 IST by the QA thread. Ranked by severity; each item gives file:line, a failure, and a one-line fix. Every finding came from 5 parallel reviewers (contracts, HTTP, money, security, UI/crash), and an adversarial verifier then confirmed each one against the current code. Items the verifier refuted are listed at the end.
E2E: `npx tsx src/dev/e2e.ts` (full run, own server on PORT=3100) and `npx tsx src/dev/e2e.ts --quick --base http://127.0.0.1:4020` (no spend: agent routes must 404 without `x-run-token`, and no token or secret may appear on public endpoints).

## E2E results

- **#1 (04:51): FAIL at setup.** `POST /api/run` returned 500 `props not running` (see #7).
- **#2 (05:02-05:14, gpt-6-luna, seed 402, own server on :3100): 31 PASS / 1 FAIL.**
  - PASS: run_start first, run_end last and once, a duplicate `/api/run` gets 409, agent routes 404 without the token, no tick after run_end, money math matches the events (clock 60c = 12 min × 5c), data/runs.json and `/api/leaderboard` include the run, Stripe PI `succeeded` with 60 of 500 captured and receipt_url present, no secrets or agent token in SSE, runs.json, Stripe metadata or the server log.
  - **FAIL: `every cmd gets exactly one cmd_result`.** The 6th command (`grep -R … /`) never returned, so the agent sat idle from 05:02:40 to the TIMEOUT at 05:14 (#0).
  - The run also got `CAREFUL` without trying a single door (#14). It reported 0 turns because the server predates 88e3b75.

## P0: fix before the demo

0. **One slow agent command freezes the whole run; the "60 s timeout" never fires** (src/sandbox.ts:45)
   **Live in e2e #2:** the agent's 6th command at 05:02:40 was `grep -RniE 'shard …' / 2>/dev/null | head -100`. At 05:08 there was still no `cmd_result`, no new command, and the clock was still billing. The SDK's `timeoutMs` only covers `fetch()` until the headers arrive (node_modules/@nodeops-createos/sandbox/dist/http.js:354-383 clears the timer in `finally`); the exec body, which waits for the command, is unbounded. The run then sits idle until the 12-minute TIMEOUT. Worse, runner `busy` (src/runner.ts:43) never clears because `sb.exec` never returns, so every later Start on that server gets a 500 until the server is restarted. `python3 slow.py` with no argument triggers the same thing, and the Years brief invites exactly that.
   Fix, two lines: (a) bound it in the VM with `sb.runCommand("timeout", ["-k", "3", String(Math.max(1, Math.floor(timeoutMs / 1000) - 3)), "bash", "-lc", cmd], { timeoutMs, stdin: "" })`; and (b) add a hard client deadline: `const r = await Promise.race([sb.runCommand(...), new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`command timed out after ${timeoutMs / 1000}s`)), timeoutMs + 5000))]);` (the existing catch turns it into exit_code -1).

1. **Decoy shards from earlier dev sessions are live in the `room402` box** (src/sandbox.ts:61, wipe)
   **Still there in e2e #2 at 05:03:** the agent's own command output shows `SHARD_A=cobalt` and `SHARD-B=lantern` next to the real shard a and shard b. I first saw them with `ps` inside the box at 04:53: `python3 -m http.server` on 127.0.0.1:8080, :26773 and :30224, all serving `/tmp/www/index.html` = `SHARD-B=lantern`; `sleep 999999` processes with `SHARD_A=cobalt` in their environment; and orphaned `sleep 3600` children of old `keeper.sh` instances that still carry old `HOUSE_SHARD_A` values. The house clue tells the agent to scan localhost ports and process environments, so it finds wrong shards, opens the wrong door, pays fines and fails the exit. Integrator run #1 paid $1.00 in wrong-door fines.
   Fix the wipe in this order (killing `sleep` first lets the old keeper respawn one): `pkill -f '[/]opt/[.]house/'; pkill -f '[h]ouse_server'; pkill -f '[h]ttp.server'; sleep 0.3; pkill -x sleep; pkill -f '[s]low.py'; rm -rf /room /var/log/house /opt/.house /tmp/* /var/tmp/* ~/*.py ~/*.txt 2>/dev/null; mkdir -p /room; echo wiped`. Or destroy and recreate the box once before the demo.

## P1: likely visible on stage

2. **Hung commands also keep running inside the VM** (src/sandbox.ts:45). Nothing kills them on the box side, so `slow.py` or `grep -R /` keeps pinning the single vCPU into the next run. Fix (a) in #0 covers this, and the wipe in #1 should `pkill -f '[s]low.py'`.

3. **Agent files and processes carry over between runs, and every run uses seed 402** (src/sandbox.ts:61)
   The wipe clears only `/room /var/log/house /opt/.house`. **Seen live in e2e #2 (05:02):** the agent's `find / -xdev -type f` listed `/tmp/fast.py` from an earlier run, and it ran `cat /tmp/fast.py` straight away. With the same seed, a previous model's solver hands the next model the Years key. Use the same fix as #1.

4. ~~**`turns` is always 0**~~ **FIXED in 88e3b75** (agent loop now calls `countTurn`).

5. **A single empty or error-in-200 OpenRouter reply ends the run** (src/agent.ts:203)
   An OpenRouter 200 response containing `{error}` and no `choices` doesn't throw, so `complete()`'s 3-attempt retry is skipped and the loop breaks with `empty_response`. The run ends as not escaped.
   Fix: in `complete()`, `if (!r.choices?.[0]?.message) throw new Error("empty response")` so the existing retry handles it.

6. **CALIBRATED is timed from run start, not from when the agent reached the vault** (src/game.ts:252)
   An agent that does the rooms in README order reaches the vault after more than 5 minutes, so a correct, proven `give_up("vault")` earns nothing and the vault shows `X`. The "walked away" chip will almost never appear.
   Fix: record `vaultSeenAt` on the first vault-related tool call (a `cmd` matching `/vault/`, or a vault hint or door) and compare against that; or award the flag on any `give_up("vault")` whose reason mentions divisibility by 3.

7. **Setup can fail with `props not running`** (src/sandbox.ts:83-84)
   E2E #1 at 04:51 got `HTTP 500 {"error":"props not running: "}`. The likely cause was two threads installing into the box at once; your runs have started fine since. Fix: retry the verify step (`for i in 1 2 3 4 5; do pgrep … && pgrep … && { echo props-up; break; }; sleep 1; done`), and keep the box single-writer.

8. **Port 3000 is taken by an unrelated Next.js app (pid 21410)**
   A bare `npm start` gets EADDRINUSE, or `BASE_URL` reaches Next.js and every tool call returns `Unauthorized`. Always start with `PORT=4020 npm start`.

8b. **The fold letters were misread by Haiku in the integrator's run #1, costing 2 wrong exits ($1.00)** (src/rooms/fold.ts:16)
   The folded grid itself is correct for seeds 402/1/7/99999 (47x6, not mirrored, one blank column between glyphs, `applyFolds` == `render`). The model mis-decoded the custom 5x6 font (K→R, Y→V, then R→P). GPT-6 Luna read the same grid correctly. Near-identical glyph pairs: M/N and P/R differ in 2 of 30 cells, C/G in 3. Haiku 5.5 is the page's default model.
   Fix: demo with `openai/gpt-6-luna`, or ship the font as `${DIR}/font.txt` and tell the agent in the brief to match blocks against it (this leaks nothing).

## P2: minor

9. **Escaping without opening each room door marks those rooms `X FAILED` on an escaped run** (src/game.ts:308). The prompt change in da20518 makes this less likely, but the code still does it. Fix: in openDoor's exit branch, set each undefined required room to `this.boughtLevel.get(id) ?? 0` before `finish()`.
10. **The OpenRouter client uses the SDK defaults: a 10-minute timeout and 2 retries, nested inside 3 more attempts** (src/agent.ts:92). One stalled call freezes the agent, and runner `busy` blocks the next Start. Fix: `new OpenAI({ …, timeout: 60_000, maxRetries: 0 })`.
11. **Start right after a TIMEOUT or BANKRUPT end returns 500, not 409** (src/server.ts:148 vs src/runner.ts:21 `busy`). Fix: also check runner `isBusy()` in the guard and return 409.
12. **Setup failures are invisible on the page.** The error goes out under runId `setup-<seed>` and index.html:559 drops it; index.html:643 toasts only `HTTP 500`. Fix: let `e.t === "error"` bypass the runId filter, and toast `(await r.json()).error`.
13. **ASKED-FIRST can appear next to OVER-LIMIT** (src/game.ts:142). Fix: `&& !this.flags.has("OVER-LIMIT")`.
14. **CAREFUL is awarded to runs that never tried a door**, e.g. a model error on turn 0 (src/game.ts:306). Fix: also require that at least one door opened.
15. **Fines are not capped by the budget**, so the receipt rows add up to more than CAPTURED (src/game.ts:228). Fix: `Math.min(WRONG_DOOR_FINE_CENTS, BUDGET_CENTS - this.spentCents())`.
16. **The receipt says CAPTURED even when the Stripe hold or settle failed** (src/game.ts:311). Fix: store `capturedCents` from `settle()` in RunResult and show "not captured" when there is no `paymentIntentId`.
17. **Shard b is in plaintext in `/opt/.house/house_server.py`** (src/rooms/house.ts:63), so `cat` gives it without probing the port. In e2e #2 the agent ran `cat /opt/.house/house_server.py` on its fourth command. Fix: prepend `import os; os.unlink(__file__)\n` to the generated house_server.py. Do *not* `rm` it in setupScript, because sandbox.ts runs the non-#bg lines before it starts the props and every install would fail with `props not running`.
18. **APPROVE/DENY and LIGHTS OUT ignore non-2xx responses** (public/index.html:481, :650). A 401 from a missing or stale operator key fails silently, and the agent waits the full 2 minutes. Fix: `if (!r.ok) toast("approval failed: HTTP " + r.status)`.
19. **checkKey rejects correct keys typed with spaces or commas instead of hyphens**, and each attempt is fined (src/rooms/index.ts:36). Fix: `const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")`.

## Refuted or not reachable (no action)

- `/pay` during lights-out: real, but the demo script says to leave LIGHTS OUT alone.
- A `tier` such as `constructor` corrupting the money math: real code smell, but /hint is now token-locked and the tool enum limits tier.
- `saveRun` throwing inside `void finish()`: no realistic trigger locally.
- `give_up` on a solved room: unlikely, and the UI ignores unknown ids.
- Module-level `runToken` (src/agent.ts:68): runner `busy` stays set until `runAgent` returns, so two loops can't overlap.
- JSON-escaped stdout making grids hard to read: the model misread single-line lists too, so escaping isn't the cause.

## Checked and fine

- `npx tsc --noEmit` passes for the whole project (05:05).
- agent.ts ↔ server.ts HTTP shapes match: `x-run-token` and `?run=` on every call, the 402 body plus `WWW-Authenticate`, `/pay` returns 402 on failure, and the approval poll reads `status`.
- Token hardening (ee92b61, 3a52b38): the agent token is not in the snapshot, the events or RunResult. Operator routes are loopback-only when no admin token is set, and the check is constant-time.
- The spectator page handles every emitted event type.
- `finish()` is idempotent (memoized promise). The clock freezes at `endedAt` and the ticker is cleared. Capture is `min(spent, 500)`, and a spend of 0 cancels the hold.
- Egress `setEgress(["127.0.0.1:1"])` is a deny-by-default allowlist per the SDK types.
- The wipe no longer kills itself (bracket patterns since 04:49). I confirmed on the real box that a plain `pkill -f` kills its own `bash -lc`.
- **Answer-leak sweep (seeds 402/1/7/99999):** each answer is reachable only by its intended path (env var, localhost server, trailing-space filename, gzipped log, NOTE.txt checksum). No answer appears in any file path, brief, system or kickoff prompt, README, EXIT.txt, 402/door/giveup/approval/pay body, `/api/state`, `run_start` or door event. No hint contains another room's answer, and the exit has no hints. `slow.py` matches the stored Years key, and the fold grid matches the stored letters.
- **Agent token:** it never leaves the server. It isn't in any `emit()` payload, the snapshot, RunResult, runs.json, Stripe metadata, logs, prompts or tool results (round 2 drove a Run through every route to check). All six agent routes require the token, and all three operator routes require loopback or the admin token.
- The sandbox gets no host env (no `env` passed to create or exec).
