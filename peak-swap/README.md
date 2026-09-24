# Peak Swap

Standalone Peak-branded Solana swap interface and integration API, using Jupiter Swap API V2 managed `/order` + `/execute`. Cloudflare Worker via Vinext, D1 for order integrity/idempotency and rate limits. Source is maintained in the Site repository.

## Launch state

The module is implemented and publishes privately with trading OFF. The Peak server integration key is configured as a Sites secret and supplied separately in `Peak_Swap_Access.env`. No Jupiter key or treasury/referral address has been supplied. No funded mainnet swaps or fee receipt tests have run. This is not an externally audited exchange.

## Activate

1. Obtain a Jupiter API key from https://developers.jup.ag/portal . Add `JUPITER_API_KEY` as a Site secret.
2. Using Peak's treasury wallet, create a Jupiter Ultra referral-project account at https://referral.jup.ag . Add the referral account address as `JUPITER_REFERRAL_ACCOUNT` (not the treasury address).
3. Initialize its referral token accounts for WSOL and USDC, and other fee mints required by your pairs. Missing accounts cause fee validation to block the quote.
4. With owner authorization, make the Site public for external buy links and server-to-server requests. The private Sites access layer otherwise requires owner sign-in even when the caller has a Peak bearer key.
5. Set `PEAK_TRADING_ENABLED=true` and deploy. Check `/api/v1/health`.
6. Run small owner-approved buy/sell acceptance transactions: SOL/USDC, a supported pre-graduation bonding curve, a migrated PumpSwap token, Raydium, Meteora and Orca where routed. Verify Jupiter routing, fees received, actual net amounts, expiry/retry behavior and chart/buybot visibility. Never assume all pools or tokens are supported. Turn the flag off and redeploy to stop new submissions.

No private wallet keys belong in this service. The API key and fee address are never accepted from swap callers. Fee policy: 125 bps total (100 bps Peak + 25 bps Jupiter share), not 1% plus an independently stacked platform charge. Extra gasless recovery fees are rejected by the exact-fee check.

## Customer interface

`/` supports injected Phantom and Solflare; on phones use the wallet's own in-app browser. User signs each transaction. Exact integer amount conversion; search by mint or symbol; slippage choices; review of minimum received, impact, route and estimated network/account costs. The public mint address is shown in the token picker. No balances or portfolio custody are managed here.

`/?outputMint=TOKEN_MINT&ref=GROUP_ID` opens a buy link. References are attribution only, not trusted payout instructions. Mainnet only. Do not submit devnet signatures.

## API

See `/developers` and `/openapi.json`. `sdk/peak-swap.ts` is a small server-side TypeScript client.

- GET `/api/v1/health`
- GET `/api/v1/tokens?query=...`
- POST `/api/v1/orders`: `{inputMint,outputMint,amount,taker,slippageBps?,source?}`. Atomic amount as a string. Returns `{id,expiresAt,transaction,quote}`.
- Customer wallet signs the returned base64 VersionedTransaction without modifying the message.
- POST `/api/v1/execute`: `{id,signedTransaction}`.
- GET `/api/v1/orders/:id`: confirmation status.

External server writes require `Authorization: Bearer PEAK_API_KEY`. Never expose this key in browser code. Same-origin frontend writes do not need the integration key; wallet cryptographic signatures authorize actual spending. CORS is intentionally closed: other websites call their own backend or send users to a Peak buy link.

Order UUIDs are access capabilities: do not log them in analytics or share them. Database stores wallet address, exact unsigned message, route/fee quote, source, times, signed-transaction hash and outcome; never private keys or the full signed transaction. A same-tab session stores only the pending order ID to recover authoritative status from D1 after reload.

## Security boundaries

- Bounded requests, address/amount/schema validation and per-IP persistent rate limits.
- Fixed Jupiter upstream prevents arbitrary URL forwarding; upstream timeouts.
- Stored unsigned message must match submitted signed transaction exactly.
- Ed25519 customer signature verification before execution.
- Atomic D1 order claim prevents concurrent submissions. A stale claim can be recovered after 60 seconds, only for the same signed bytes.
- Duplicate completed execution returns its stored result. Unknown results never create a new order automatically.
- 45-second max quote age (or shorter upstream expiry), 10% impact cutoff, 5% maximum slippage and 0.001 SOL priority-fee cap. These are initial policy limits, not token safety guarantees.
- Referral account and fee rate validation fails closed. Jupiter is trusted to construct correct swap instructions; Peak does not independently emulate every DEX program.
- Browser CSP, no cross-origin browser API writes, no embedding, no-store API responses.

Do not claim that all charting providers will see a transaction, that all pre-migration tokens route, or that transactions are MEV-proof. No direct-venue fallback, payouts, managed wallets or outbound webhooks are implemented. Consumers can poll status; confirmed results are available for future Peak Buy Bot integration.

## Checks and local work

Use the Sites dependency installer and build workflow. Optional websocket native addons `bufferutil` and `utf-8-validate` are explicitly disabled; their JS fallbacks suffice. `buffer` is bundled for browser Solana transaction support.

- `node node_modules/typescript/bin/tsc --noEmit`
- `node scripts/test-security.mjs` (Node 24; mocked Jupiter transport, real SQLite and Ed25519 signatures)
- `node node_modules/drizzle-kit/bin.cjs generate` only when schema changes
- Build with the Sites build helper. Keep generated D1 migrations and snapshots.

Security tests cover precise amounts, message tampering, invalid signatures, fee bypasses, impact/slippage/priority limits, expired orders, duplicate/concurrent execution, timeout recovery, origin/bearer authorization and persistent rate limits. No test spends money.
