# Deploy notes (Room 402)

**Status 05:36 IST:** CreateOS hosting does not work. Nine deployments since 05:03 across `room402` and `room402live` (node 20/22/24, tsx and bundled, 200m-500m CPU, a known-good spike app, all other deployments asleep) built cleanly but never became ready (nginx 503), so there is no CreateOS URL. All are now asleep, and credits are unchanged at 498.08 (no 480 CC scan was charged).
**Primary deploy is the Oracle VM** (https://140-238-225-242.sslip.io, soon https://room402.souryax.space). The token-protected cloudflared tunnel in `docs/DEPLOYED_URL.txt` still runs from this Mac as a backup; stop it with `R402_LOCAL_PORT=4021 scripts/tunnel.sh stop`.

Written by the deploy owner on 2026-10-18, 04:45–05:45 IST.

## Scripts

| Script | What it does |
| --- | --- |
| `scripts/deploy.sh` | CreateOS upload deploy. Creates or reuses the project (default `room402`) and its `production` environment, sets env vars, uploads a staged copy (`package*.json`, `tsconfig.json`, `src/`, `public/`), waits for the build, promotes the deployment, then verifies `GET /`, `GET /api/leaderboard`, `GET /health` and 10 s of `/events`. Other modes: `setup`, `verify [url]`, `credits`, `status`. |
| `scripts/tunnel.sh` | Fallback hosting. Runs Room 402 on this Mac (default `:4020`; `R402_LOCAL_PORT` overrides) behind a cloudflared quick tunnel, keeps the Mac awake with `caffeinate`, verifies the public URL, and refuses to publish if operator routes answer without the token. `--write` writes the URL to `docs/DEPLOYED_URL.txt`. Other modes: `stop`, `status`. |
| `scripts/check-secrets.sh` | Pre-push check over tracked and untracked-not-ignored files, plus the staged copies. It looks for `sk_test_`, `sk_live_`, `rk_`, `skp_` and `sk-or-` tokens, and for the literal value of every secret in `.env`, `.env.local` and the admin token file. It prints only `path:line` and exits 1 on a hit. |

No secret is printed or put on a command line. API calls read the key from a 0600 curl config file. Env var values reach the API through `jq env.*` and a 0600 temp file.

## The 480 CC security scan: not charged

- The pricing table lists "Security Scan (480 CC per deployment)", and the docs say "every deployment includes an automatic security scan". In practice the scan is a per-project flag. Every project created with `createos projects add` reports `enabledSecurityScan: false` and `addonsQuota.securityScanEnabled: false`. The CLI has no flag that turns it on.
- I confirmed this by measuring: I made 9 deployments across 3 projects, and the balance stayed at **498.08 credits** throughout. The 1.92 already spent was earlier sandbox use. Balance comes from `GET https://api-createos.nodeops.network/v1/credits` (`data.amount`), or `scripts/deploy.sh credits`.
- `deploy.sh` refuses to deploy if either scan flag is ever `true` (override with `R402_ALLOW_SCAN=1`).

## CreateOS quirks found (all handled in deploy.sh)

1. **Build step.** With no build command, the builder runs `npm run build`. package.json has no `build` script, which is why the first spike ended in `build_error`. deploy.sh sets the build command to an esbuild bundle (`dist/server.mjs`; esbuild comes with tsx) and the run command to `node dist/server.mjs`. Override with `R402_BUILD_CMD` and `R402_RUN_CMD`.
2. **Runtime.** `openai@7` requires Node >= 22 (`EBADENGINE` on `node:20`). The default is `R402_RUNTIME=node:24`. Supported runtimes: `node:20`, `node:22`, `node:24`.
3. **Env vars belong to an environment, and a new project has none.** deploy.sh creates `production` with `settings.runEnvs` via `POST /v1/projects/{id}/environments`, and refreshes them later with `PUT …/environments/{env}/environment-variables`. Vars set: `STRIPE_SECRET_KEY`, `OPENROUTER_API_KEY`, `CREATEOS_PROJECT_API_KEY`, `CREATEOS_SANDBOX_API_KEY` (same value), `CREATEOS_SANDBOX_BASE_URL=https://api-eu.sb.createos.sh`, `ROOM402_ADMIN_TOKEN`, `NODE_ENV=production`. `ROOM402_BASE_URL` is never sent; the in-container default is the right value. A spike app confirmed that these values reach the runtime.
4. **Project settings can be changed after creation** with `PUT /v1/projects/{id}/settings` (the CLI has no command for it). deploy.sh uses this to enforce runtime and commands on reused projects.
5. **Use the environment URL**, `https://production-<unique-name>.tyzo.nodeops.app`. The per-deployment `dep-<id>…nodeops.app` URL accepts TLS and then hangs.
6. **`createos deploy` treats `build_error` as still in progress** and polls for 10 minutes. deploy.sh polls the API itself, and on failure prints the tail of the build log (redacted).
7. **List endpoints are paginated** (`{data: {data: [...], pagination}}`); environments return a plain array.
8. **Deleted projects keep their unique name** (`available-unique-name` returns false), so `room402` can't be recreated.
9. **Plan limits:** 2 active deployments and 2 active environments. Deployment CPU is capped at 500m on this plan, even though `/v1/credits` says 1000. A deployment that is replaced is not stopped automatically. `DELETE /v1/projects/{id}/deployments/{dep}` puts it to sleep (`createos deployments sleep`).

## What happened on deploy day

- The integrator created `.deploy-go` at 05:02:55 IST.
- **Every CreateOS deployment from 05:03 on built cleanly but never became ready.** The environment URL answered nginx `503 Service Temporarily Unavailable` for as long as I watched, and the runtime-log endpoint returned only `Listening for logs...`. Variations tried:
  - Runtime `node:20`, `node:22` and `node:24`.
  - `tsx` at runtime, and a plain-node esbuild bundle.
  - CPU/memory at 200m/500Mi and at 500m/1Gi.
  - Two projects (`room402`, `room402live`), with all other deployments asleep.
  - The 04:51 spike app, which had served 200 on a fresh project, also returned 503 when deployed to `room402` at 05:23.
- The same staged bundle boots locally from a clean `npm install` in about 2 s (tsx) and under 1 s (bundle), with only the platform env vars and no `.env` files.
- **Conclusion:** the problem is on the platform side. Room 402 is served through the tunnel fallback; see `docs/DEPLOYED_URL.txt`.

## Live fallback (tunnel)

- `R402_LOCAL_PORT=4021 scripts/tunnel.sh --write` runs a dedicated Room 402 on `:4021`, started with `ROOM402_ADMIN_TOKEN`. The integrator's dev server on `:4020` runs without a token. Through cloudflared every request arrives from 127.0.0.1, so tunneling that server would let anyone start runs.
- Verified through the public URL: `GET /` 200, `/health` ok, `/api/leaderboard` 200, `/events` 200 with `text/event-stream`, and unauthenticated `POST /api/approval/<bogus>` returns **401**.
- **Operator:** open `<url>/#key=<token>`. The token is in `/tmp/r402-spikes/secrets/admin_token` (0600) and never appears in the repo.
- The `:4021` instance and the `:4020` dev server share the one sandbox `room402` and `data/runs.json`. Don't run games on both at once.
- **Caveats:**
  - A new quick-tunnel hostname can be NXDOMAIN-cached by this Mac's resolver for minutes while the rest of the internet already reaches it. tunnel.sh checks through 1.1.1.1.
  - The 15 s SSE keep-alive pings did not arrive through the quick tunnel within 34 s, although headers did, and locally the ping arrives at 15 s. Live spectator updates may lag through the tunnel. A server-side fix would be `Cache-Control: no-cache, no-transform` plus an initial comment frame on connect (this is `src/server.ts`, not deploy-owned).
- The tunnel lives only while this Mac is awake and online. `scripts/tunnel.sh status` shows it; `scripts/tunnel.sh stop` stops it.

## Cleanup (after judging)

CreateOS projects `room402` (`ced8b6dc…`), `room402live` (`9a156fdf…`) and `r402 spike` (`57df1e73…`). Their deployments are asleep or failed, and the security scan is off on all three. Delete with `createos projects delete --project <id> --force`.
