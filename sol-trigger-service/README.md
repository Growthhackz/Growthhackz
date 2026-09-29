# Sol Trigger Service

Trigger-driven Solana wallet automation with a private dashboard.

1. **Trigger.** Your system calls `POST /v1/trigger` with a token contract address (CA).
2. **Initial receiver.** The funding wallet immediately sends a set amount of SOL to the initial receiver.
3. **Delayed buys.** After its own buy delay (10 min by default), every enabled trading wallet buys the CA with a set % of its SOL (through Jupiter). Each wallet then sells a set % of its remaining tokens every N hours.
4. **Sweep.** From the dashboard, pick any wallets (or all of them) and send all their SOL to the final receiver.

Everything except the environment variables is configured from the dashboard and can be changed at any time.

## Run it

```bash
npm install
cp .env.example .env      # fill in DASHBOARD_PASSWORD, TRIGGER_API_TOKEN, ENCRYPTION_KEY
npm run dev               # or: npm run build && npm start
npm test
```

Open `http://localhost:4030` and log in. For plain-http localhost, set `COOKIE_SECURE=false`. Requires Node ≥ 22.5, which provides the built-in `node:sqlite`.

**Deploy (Railway).** Set the service root to `sol-trigger-service/`, attach a volume at `/data`, and set the env vars. The Dockerfile and `railway.json` (health check `/health`) are included.

**Production RPC.** Use a paid RPC (Helius, Triton, QuickNode) for `SOLANA_RPC_URL`. The public endpoint rate-limits and drops transactions.

## Dashboard

| Section | What it does |
|---|---|
| Triggers ON/PAUSED | Master switch. While paused, triggers are logged as `ignored` and nothing is sent. |
| Initial receiver | Address and SOL amount sent on each trigger. Delete it to skip this step. |
| Final receiver | Where sweeps send SOL. Under Advanced: the priority fee for plain SOL transfers (funding and sweeps). |
| Funding wallet | The SOL-holding wallet that pays the initial receiver. Import a key or generate one. |
| Trading wallets | Add as many as you want: import a key or generate one. Each has its own **Buy after (minutes)**, **Buy % of SOL**, **Sell % of tokens** and **Every (hours)**, plus Advanced: **slippage**, **keep back (SOL)** and **max priority fee per swap**. Edit, disable or remove any wallet at any time. New wallets start with the last wallet's settings. Changing a wallet's delay also moves its buys that are still waiting. |
| Sweep | Tick wallets (the header box selects all, the funding wallet included), then press Sweep. Each wallet's full SOL balance minus the network fee goes to the final receiver. |
| Positions | One row per wallet per trigger: waiting → buying → holding ⇄ selling → closed. **Sell all now** and **Stop** are available here. |
| Manual trigger | Fires the full flow from the dashboard. This is real: it moves SOL. |

## Trigger API

```bash
curl -X POST https://<host>/v1/trigger \
  -H "authorization: Bearer $TRIGGER_API_TOKEN" -H 'content-type: application/json' \
  -d '{"contractAddress":"<mint>","eventId":"optional-unique-id"}'
```

- The address field can also be named `ca`, `mint` or `contract_address`. The token can also go in an `x-api-key` header.
- A repeat with the same `eventId` (or `Idempotency-Key` header) returns `200` with the original trigger. It never buys twice.
- Response `202`: `{ triggerId, status, funding, scheduledBuys, note }`.

## How trading works

- **Buy time** = trigger time + that wallet's "buy after" minutes.
- **Buy amount** = `buy %` × the wallet's SOL balance at buy time, capped so that the wallet's "keep back" (default 0.01 SOL) stays in the wallet for fees and token-account rent.
- **Sells** fire every `interval` hours. Each sells `sell %` of what the wallet *currently* holds. With 25% every 2 h, the wallet sells 25% of the remainder each time. At 100%, or when the remainder rounds to zero, the wallet sells everything and the position closes. A sell of 0% means hold.
- If a wallet already has an open position in the same CA, a new trigger skips that wallet so its sells don't double up.
- Swaps go through the Jupiter Swap API, which covers Raydium, Orca, Meteora, pump.fun and others. A token Jupiter can't route yet, such as one only seconds old, is retried every 20 s, up to 5 attempts. A failed sell retries every minute, up to 5 times, then waits a full interval.
- Disabling a wallet stops its new buys and pauses its sells. Removing a wallet hides it and stops its positions. Its encrypted key stays in the database.

## Safety

- **Private keys:** encrypted at rest with AES-256-GCM (`ENCRYPTION_KEY`). They are never returned by the API. A generated wallet's key is shown **once** so you can back it up.
- **No double sends:** every transaction is signed and recorded before it is broadcast. It is then resolved by signature: confirmed, failed on-chain, or expired once its blockhash can no longer land. A crash or timeout mid-send can never cause a blind resend. Retries happen only after expiry proves the first attempt is dead.
- **Dashboard:** single password, HttpOnly/SameSite=Strict signed session cookie, and login throttling (5 failures per IP per 15 min). JSON-only mutations plus an Origin check block CSRF. The dashboard sets a strict CSP and `X-Frame-Options: DENY`.
- **Funding:** refuses a transfer that would leave the funding wallet below rent-exempt.

## Layout

```
src/
  app.ts                 Fastify app, auth hooks
  routes/trigger.ts      POST /v1/trigger (token auth)
  routes/dashboard.ts    /api/* (session auth) and the dashboard page
  dashboard/page.ts      the single-page dashboard
  services/engine.ts     triggers, funding, buys, sells, sweep, tx confirmation
  services/settings.ts   dashboard settings
  services/wallets.ts    wallet import/generate/edit/remove
  solana/                RPC client, Jupiter client, transfer building and signing, key parsing
  workers/scheduler.ts   background loop (every TICK_INTERVAL_MS)
```
