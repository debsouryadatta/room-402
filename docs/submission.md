# Room 402 submission kit

Every form field is below, ready to copy. Anything in angle brackets, like `<VIDEO_URL>`, is a placeholder. Replace it before you submit.

## Basics

| Field | Value |
|---|---|
| Team name | Sourya Solo |
| Team members | Debsourya Datta (Discord: debsouryadatta1220) |
| Project name | Room 402 |
| Hackathon | Build Agents That Run Code (CreateOS x Stripe Projects) |
| License | MIT |

## One-sentence description

Room 402 is an escape room for AI agents inside a CreateOS sandbox, where the only way out is code the agent writes and every hint sits behind an HTTP 402 paid from a Stripe test-mode hold.

## Three-sentence description

Room 402 locks an AI agent inside a CreateOS sandbox, a Linux microVM, where the only way through four rooms and out the exit door is to write and run code. Every hint sits behind a real HTTP 402 Payment Required response and is paid from a $5 Stripe test-mode authorization hold, while time costs $0.05 a minute and each wrong door costs $0.50. When the run ends, Stripe captures only what the agent spent and issues a receipt, and the leaderboard ranks Claude Haiku 5.5 against GPT-6 Luna by escapes first, then by fewest dollars.

## Longer description (about 120 words)

Every agent will soon have a wallet. Room 402 tells you which ones deserve one.

The room is a CreateOS sandbox, a Linux microVM. An agent gets 12 minutes, 80 turns and a $5 Stripe authorization hold. To escape, it must explore a dark house, rewrite a loop that would take about ten thousand years, fold a dot grid, and decide whether a $3 vault is worth chasing. (It isn't. Any number whose digits sum to 33 is divisible by 3, so no 7-digit prime fits the lock.) Hints cost $0.50, $1.00 or $2.00 behind real HTTP 402 invoices. Time costs $0.05 a minute and wrong keys cost $0.50. Past $1 of hints and fines the agent is told to ask a human judge for approval, and skipping that earns an OVER-LIMIT flag. Stripe captures only what was spent and issues a receipt. Spectators watch it live.

## Tech stack

TypeScript run with tsx, Hono on @hono/node-server with Server-Sent Events, @nodeops-createos/sandbox, openai SDK pointed at OpenRouter, stripe Node SDK (test mode), Stripe CLI with the `projects` plugin, deployed on CreateOS hosting.

## How it uses Stripe Projects

- One CLI set up the whole stack: `stripe projects init room-402`, then `stripe projects add createos/free`, `stripe projects add createos/project` and `stripe projects add openrouter/api`.
- `stripe projects env --pull` writes the CreateOS and OpenRouter credentials into `.env`. No CreateOS or OpenRouter keys were copied by hand from dashboards. Only the Stripe test key is set by hand, in `.env.local`.
- The stack is shareable as one link: https://projects.dev/s#v1:createos~project,OpenRouter~api
- Stripe test mode runs the money. Each run opens a $5 manual-capture PaymentIntent, confirmed `off_session` with the test card `pm_card_visa` saved to a Customer. Every paid hint and fine becomes a ledger line in the PaymentIntent metadata (`l1`, `l2`, ...). At the end Stripe captures only the amount spent, releases the rest and puts a `receipt_url` on the charge. If nothing was spent, the hold is cancelled.

If a form asks about MPP: we tried Stripe's Machine Payments Protocol first. The mppx server's 402 challenge worked, but payment could not settle on our India account (acct_1NuDtbSHblgLM35H). RBI rules require 3DS on every card payment, which an agent can't complete, and Shared Payment Tokens can't be confirmed off-session. So we built our own 402 flow on top of an off-session hold and capture.

## How it uses CreateOS Sandbox

- The room is a real CreateOS sandbox: one reusable box named `room402` (rootfs `devbox:1`, shape `s-1vcpu-1gb`), created through @nodeops-createos/sandbox with ingress enabled. Every run reuses it, so runs go one at a time.
- The server itself runs on CreateOS hosting, deployed with `scripts/deploy.sh`.
- The agent's `run_command` tool executes inside the sandbox. The agent loop runs on our Node server, so the model only touches the room through its tools: `run_command`, `get_hint`, `pay`, `open_door`, `request_approval` and `give_up`.
- Egress is the room's walls. During a run a deny-by-default rule locks it, so the agent cannot reach the internet, and the hint shop is reachable only through tools on our server.
- The puzzles use real Linux features: a shard in a background process's environment, a localhost HTTP server, a filename with a trailing space and a gzipped log.
- At the start of each run the server wipes `/room`, kills the old background props, uploads fresh files built from the run's seed and starts the props again. The seed defaults to 402, so every run builds the same house unless you change it.

## Links

| Field | Value |
|---|---|
| Demo video URL | `<VIDEO_URL>` |
| Repo URL | `<REPO_URL>` |
| Post URL | `<POST_URL>` |
| Deployed URL | `<DEPLOYED_URL>` (the CreateOS hosting URL, which `scripts/deploy.sh` writes to `docs/DEPLOYED_URL.txt`) |
| Stripe Projects share link | https://projects.dev/s#v1:createos~project,OpenRouter~api |

## Optional fields

| Field | Value |
|---|---|
| Run it locally | `stripe projects env --pull` (writes `.env`), optionally a test `STRIPE_SECRET_KEY` in `.env.local` (otherwise a mock wallet), then `npm install`, `npm start`, open http://localhost:3000, pick a model and start a run (`POST /api/run`) |
| Contestants | Claude Haiku 5.5 (`anthropic/claude-haiku-5.5`) vs GPT-6 Luna (`openai/gpt-6-luna`) via OpenRouter |
| Result headline | `<RESULT_HEADLINE>` (fill in from real runs only) |
| Prior art | EscapeBench (arXiv 2412.13549, ACL 2025) was our inspiration: a text-only escape game with free hints after 50 failures. Terminal-Bench has a real terminal but no money. Cybench uses CTF challenges. Vending-Bench uses simulated money. Room 402 adds a real computer, code the agent writes, hints the agent pays for, and time that costs money. |

## projects.dev leaderboard submission

1. Run `stripe whoami` and copy the account id. It should be `acct_1NuDtbSHblgLM35H`.
2. Run `stripe projects share`. It prints the share link: https://projects.dev/s#v1:createos~project,OpenRouter~api
3. Paste the repo URL: `<REPO_URL>`.
4. Paste the deployed URL: `<DEPLOYED_URL>` (the CreateOS hosting URL, in `docs/DEPLOYED_URL.txt` after `scripts/deploy.sh` runs).
5. Enter the hackathon code `CreateOS-2026`. It is case-sensitive. Type exactly that: capital C, capital O, capital S, a hyphen, then 2026.

## Pre-submit checklist

- [ ] Demo video uploaded and set to public or unlisted. Link pasted in place of `<VIDEO_URL>`.
- [ ] Repo is public, with `README.md` and `LICENSE` (MIT) at the root.
- [ ] No secrets committed. `.env` and `.env.local` are gitignored (`.gitignore` has `.env` and `.env.*`). `git ls-files | grep '\.env'` prints nothing, or only `.env.example`.
- [ ] Deployed URL responds on `/health`. `curl <DEPLOYED_URL>/health` returns `{"ok":true}`.
- [ ] Post published and its URL copied in place of `<POST_URL>`.
- [ ] Submission form fields pasted from this file.
- [ ] No placeholders left in what you pasted: search for `<VIDEO_URL>`, `<REPO_URL>`, `<POST_URL>`, `<DEPLOYED_URL>` and `<RESULT_HEADLINE>`.
