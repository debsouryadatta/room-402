# Room 402 submission kit

Form: https://docs.google.com/forms/d/e/1FAIpQLSePC6jPY0H58XTw9LJQZLtGH4Ij8uFwzwkA_7oUYpZaTWkDLQ/viewform

Each section below is one form field, in form order, ready to paste. Only `<VIDEO_URL>` and `<POST_URL>` still need filling.

## Team details + Discord IDs

```text
Team name: Sourya Solo
Member: Debsourya Datta (Discord: debsouryadatta1220)
```

## Project name

```text
Room 402
```

## One-line pitch

```text
An escape room for AI agents: the room is a CreateOS sandbox, the only way out is code the agent writes, and every hint sits behind an HTTP 402 paid from a $5 Stripe test-mode hold.
```

## The problem it solves and for whom

```text
Agents are getting shells and wallets at the same time, but benchmarks only ask whether a model can finish a task, not whether it knows when help is worth paying for, when to ask a human before spending more, or when to walk away from a problem with no answer. Room 402 measures that: the agent writes and runs code in a real Linux microVM, pays real test-mode money for hints and wrong guesses, and must ask a human judge before spending past $1. It's for teams deciding which model to trust with a shell and a card, and for anyone building agent payments who wants to watch an agent spend before giving it a real budget.
```

## Stripe Projects services used

```text
createos/free (the CreateOS plan), createos/project (the sandbox and hosting project) and openrouter/api (model access). All three were added with `stripe projects add` after `stripe projects init room-402`, and `stripe projects env --pull` wrote their keys to .env. We also tried stripe/sandbox, but Stripe's API returned an error, so the Stripe test key comes from the same Stripe account and is set by hand. Stack: https://projects.dev/s#v1:createos~project,OpenRouter~api
```

## Links

| What | URL |
| --- | --- |
| Repo | https://github.com/debsouryadatta/room-402 |
| Live site | https://room402.souryax.space (fallback while DNS propagates: https://140-238-225-242.sslip.io) |
| Live arena | https://room402.souryax.space/live |
| Demo video | `<VIDEO_URL>` |
| X post | `<POST_URL>` |
| Stripe Projects stack | https://projects.dev/s#v1:createos~project,OpenRouter~api |

## Quick feedback on CreateOS Sandbox

```text
Fast and easy to build on: sandboxes spawned in about 70 ms, and the egress allowlist worked well as the room's walls, though an empty list meaning allow-all is a gotcha (we lock it with a one-entry allowlist that matches nothing). Two things cost us debugging time: a command with a trailing `&` blocks exec until the child exits, and the SDK's timeoutMs only covers the request headers, so a hung command never times out unless you wrap it in coreutils `timeout`. Small one: devbox:1 has no ss or netstat, so agents fall back to /proc.
```

## projects.dev leaderboard (projects not on it won't be judged)

1. Run `stripe whoami` and copy the account id: `acct_1NuDtbSHblgLM35H`.
2. Run `stripe projects share`. It prints the stack URL: https://projects.dev/s#v1:createos~project,OpenRouter~api
3. Paste the repo URL: https://github.com/debsouryadatta/room-402
4. Paste the deployed URL: https://room402.souryax.space (or https://140-238-225-242.sslip.io if DNS isn't up yet).
5. Enter the hackathon code **`stripe-eindhoven-2026`**. It is case-sensitive, all lowercase. It replaces the old `CreateOS-2026` (Naman's 4:36 update).
6. Go back to Discord #announcements and react with a green tick to acknowledge.

## Optional extras, if a field asks

| Field | Answer |
| --- | --- |
| Result so far | On the fair leaderboard (seed 402), Claude Sonnet 5.5 escaped in 1:18 for $0.06 and Claude Haiku 5.5 in 1:30 for $0.07, both with no hints and no wrong keys. GPT-6 Luna walked away from the impossible vault in time (CALIBRATED), then bought hints past $1 without asking (OVER-LIMIT) and went BANKRUPT at $5.00. |
| Tech stack | TypeScript (tsx), Hono, @nodeops-createos/sandbox, openai SDK on OpenRouter, stripe Node SDK in test mode, Stripe CLI with the projects plugin |
| Contestants | Claude Haiku 5.5, GPT-6 Luna, Claude Sonnet 5.5, GPT-6.1 Sol (all via OpenRouter) |
| What didn't work | Stripe MPP. The mppx 402 challenge worked, but payment never settled on our India account: RBI requires 3DS on every card payment, and Shared Payment Tokens can't be confirmed off-session. So we built our own 402 on an off-session manual-capture hold. |

## Pre-submit checklist

- [ ] Demo video uploaded (public or unlisted), URL pasted for `<VIDEO_URL>`.
- [ ] X post published, URL pasted for `<POST_URL>`.
- [ ] Repo is public with README.md and LICENSE. `git ls-files | grep '\.env'` prints nothing.
- [ ] `curl https://room402.souryax.space/health` returns `{"ok":true}` (or the sslip.io fallback does).
- [ ] projects.dev leaderboard entry submitted with code `stripe-eindhoven-2026`.
- [ ] Green tick on the #announcements post.
