# Peak Swap

Standalone Peak-branded Solana swap interface and integration API. Swaps go **directly** to the venues — Pump.fun bonding curve, PumpSwap, Raydium (CPMM, AMM v4) and Meteora (DAMM v2, DLMM) — with no aggregator in between. Peak builds each transaction itself, adds its 1% fee as a SOL transfer, and sends the customer-signed transaction through its own RPC. Cloudflare Worker via Vinext, D1 for order integrity/idempotency and rate limits. Source is maintained in the Site repository.

## Launch state

Trading is OFF until configured. Venue instruction builders are verified byte-for-byte against each venue's official SDK (see *Checks*), but no funded mainnet swaps or fee receipt tests have run yet. This is not an externally audited exchange.

## Activate

1. Get a paid Solana mainnet RPC (Helius, Triton, QuickNode…). It must allow `getProgramAccounts` (used to find Raydium/Meteora pools) and `simulateTransaction`. Add it as the `SOLANA_RPC_URL` Site secret (HTTPS).
2. Set `PEAK_FEE_WALLET` to Peak's treasury **public** address. Fund it with ≥0.001 SOL first so a small fee transfer can never fail rent-exemption.
3. With owner authorization, make the Site public for external buy links and server-to-server requests. The private Sites access layer otherwise requires owner sign-in even when the caller has a Peak bearer key.
4. Set `PEAK_TRADING_ENABLED=true` and deploy. Check `/api/v1/health`.
5. Run small owner-approved buy and sell acceptance transactions on each venue: a live Pump.fun bonding-curve coin, a migrated PumpSwap coin, a Raydium CPMM pool, a Raydium AMM v4 pool, a Meteora DAMM v2 pool, a Meteora DLMM pool, and SOL/USDC. Check the venue chosen, amounts received, the fee arriving in the treasury, and expiry/retry behaviour. Turn the flag off and redeploy to stop new submissions.

No private wallet keys belong in this service. The RPC URL and fee wallet are never accepted from swap callers.

## Fee policy

100 bps (1%) of the SOL side of every swap, paid to `PEAK_FEE_WALLET` by a system transfer inside the swap transaction:

- **Buys (SOL → token):** charged on top. `amount` goes entirely into the pool; the customer spends `amount + 1%` (`quote.totalInputAmount`).
- **Sells (token → SOL):** 1% of the quoted SOL proceeds, taken after the swap. `quote.outAmount` and `quote.minimumReceived` are net of it.

Pool fees (Pump.fun protocol/creator fees, LP fees) are included in the quoted output. There is no third-party share. `createOrder` refuses to return a transaction that does not contain the exact fee transfer, and the signed message must match it byte-for-byte.

## How routing works

`lib/router.ts`: one side of the pair must be SOL (single-hop only).

1. **Discover** the token's SOL pools: Pump.fun curve and canonical PumpSwap pool by PDA; Raydium and Meteora pools by `getProgramAccounts` on each program with mint filters (both orientations).
2. **Shortlist** the deepest pools by SOL reserve (max 2 per venue, 6 total).
3. **Measure** each by simulating the real swap for the taker against current chain state and reading back exactly what the taker receives. Venue fee rules (Pump fee tiers, DLMM dynamic fees, Token-2022 transfer fees) are therefore always the venue's own.
4. Pick the best output. Price impact = full-size rate versus a 1% probe on the same pool.
5. **Build** compute budget + fee transfer + swap, set `minOut` from slippage, simulate once more as a gate, size the compute limit from that simulation, and cap priority fees at 0.001 SOL.

Venue adapters live in `lib/venues/` (`pump.ts`, `raydium.ts`, `meteora.ts`) and depend only on `@solana/web3.js`.

Not routed: token↔token or split routes, Raydium CLMM and LaunchLab, Meteora DAMM v1 and Dynamic Bonding Curve, non-SOL-quoted Pump.fun curves, Orca and other venues. DLMM pairs trading outside the internal bin bitmap range (needs the bitmap extension walk) fail simulation and are skipped.

## Customer interface

`/` supports injected Phantom and Solflare; on phones use the wallet's own in-app browser. User signs each transaction. Exact integer amount conversion; search by mint or symbol; slippage choices; review of minimum received, impact, route and estimated network/account costs. Tokens are added by pasting the mint address (name/symbol come from Token-2022 or Metaplex metadata); only SOL and USDC are listed by symbol, and every other token requires the risk acknowledgement. No balances or portfolio custody are managed here.

`/?outputMint=TOKEN_MINT&ref=GROUP_ID` opens a buy link. References are attribution only, not trusted payout instructions. Mainnet only. Do not submit devnet signatures.

## API

See `/developers` and `/openapi.json`. `sdk/peak-swap.ts` is a small server-side TypeScript client.

- GET `/api/v1/health`
- GET `/api/v1/tokens?query=MINT_ADDRESS` (or `SOL` / `USDC`)
- POST `/api/v1/orders`: `{inputMint,outputMint,amount,taker,slippageBps?,source?}`. Atomic amount as a string. Returns `{id,expiresAt,transaction,quote}`; `quote` includes `venue`, `venueLabel`, `pool`, `outAmount`, `minimumReceived`, `feeLamports`, `totalInputAmount` and `priceImpactPct`.
- Customer wallet signs the returned base64 VersionedTransaction without modifying the message.
- POST `/api/v1/execute`: `{id,signedTransaction}`.
- GET `/api/v1/orders/:id`: confirmation status, resolved against chain state. `confirmed` / `failed` landed; `rejected` (preflight) and `expired` (blockhash passed) never landed and moved no funds; `unknown` means poll again.

External server writes require `Authorization: Bearer PEAK_API_KEY`. Never expose this key in browser code. Same-origin frontend writes do not need the integration key; wallet cryptographic signatures authorize actual spending. CORS is intentionally closed: other websites call their own backend or send users to a Peak buy link.

Order UUIDs are access capabilities: do not log them in analytics or share them. Database stores wallet address, exact unsigned message, route/fee quote, quote blockhash and its last valid block height, source, times, signed-transaction hash, transaction signature and outcome; never private keys or the full signed transaction. A same-tab session stores only the pending order ID to recover authoritative status from D1 after reload.

## Security boundaries

- Bounded requests, address/amount/schema validation and per-IP persistent rate limits.
- Fixed, server-configured RPC upstream prevents arbitrary URL forwarding; upstream timeouts.
- Stored unsigned message must match submitted signed transaction exactly.
- Ed25519 customer signature verification before execution.
- Atomic D1 order claim prevents concurrent submissions. A stale claim can be recovered after 60 seconds, only for the same signed bytes.
- Duplicate completed execution returns its stored result. A retry of an unknown submission checks the chain first and is never re-sent once landed. Unknown results never create a new order automatically.
- 45-second max quote age, 10% impact cutoff, 5% maximum slippage and 0.001 SOL priority-fee cap. These are initial policy limits, not token safety guarantees.
- Fee transfer validation fails closed. Every order's exact transaction is simulated before it is returned; Peak does not independently emulate DEX math.
- Browser CSP, no cross-origin browser API writes, no embedding, no-store API responses.

Do not claim that every token routes or that transactions are MEV-proof. No payouts, managed wallets or outbound webhooks are implemented. Consumers can poll status; confirmed results are available for future Peak Buy Bot integration.

## Checks and local work

Use the Sites dependency installer and build workflow. Optional websocket native addons `bufferutil` and `utf-8-validate` are explicitly disabled; their JS fallbacks suffice. `buffer` is bundled for browser Solana transaction support.

- `node node_modules/typescript/bin/tsc --noEmit`
- `node scripts/test-security.mjs` (Node 22.13+; mocked Solana RPC, real SQLite and Ed25519 signatures; plus venue parity tests)
- `node node_modules/drizzle-kit/bin.cjs generate` only when schema changes
- Build with the Sites build helper. Keep generated D1 migrations and snapshots.

Security tests cover precise amounts, 1% fee placement for buys and sells, message tampering, invalid signatures, impact/priority limits, failed simulations, expired quotes, duplicate/concurrent execution, timeout recovery with chain checks, blockhash expiry, preflight rejection, origin/bearer authorization and persistent rate limits. No test spends money.

`tests/venues.ts` compares every venue instruction (accounts, writability, signer flags, data) and account decoder against reference output from the official SDKs, stored in `tests/fixtures/venues.json`. When a venue upgrades its program, regenerate with `scripts/venue-fixtures.cjs` (instructions in its header) using the new SDK versions and update the adapter until the test passes.
