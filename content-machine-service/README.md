# Content Machine Service

The Peak Content Machine as a standalone microservice. It takes a token launch order from Peak Buybot and produces a project content kit:

- **Token details:** name, ticker, logo and market data from DEX Screener.
- **Copy (Gemini):** exactly three posts — one X-sized post (≤280 chars), one article and one press release — plus meme captions and trailer lines for the renderer.
- **Artwork (Gemini):** a campaign image and five matching sticker designs.
- **Rendered media:** memes, trailers and a Telegram sticker pack, made by the companion worker.
- **Publishing:** every post carries the same generated campaign image. Each post is delivered only after its public URL has been checked.

| Destination | Post | Image |
| --- | --- | --- |
| Telegraph | Article | Embedded at the top (needs `PUBLIC_HUB_ENABLED` so Telegraph can load it) |
| Binance Square | Article | Cover image, via the official `post-image.mjs` script on the worker |
| Telegram | X post as the caption, plus the hub link when the hub is public | Sent as the photo |
| X (manual) | X post | `x_handoff` on the order gives the text and the image URL |
| Hub / API | All three | Shown on the hub |
- **Callbacks:** each status change is sent to Peak as a signed webhook.

It ports the handoff build (Next.js on Cloudflare D1/R2) to the same stack as `social-activity-service`: Fastify, `node:sqlite` and zod. Assets are stored on the local filesystem behind an `AssetStore` interface.

## Run it

```bash
npm install
cp .env.example .env      # set ADMIN_API_TOKEN and CONFIG_ENCRYPTION_KEY
npm run dev               # or: npm run build && npm start
npm test
```

Requires Node ≥ 22.5 (built-in `node:sqlite`). A `demo: true` order runs with no provider keys and never spends or publishes anything.

## Auth

Every `/v1` route needs a bearer token:

| Token | Can do |
| --- | --- |
| `ADMIN_API_TOKEN` (env) | Everything |
| Service key from `POST /v1/keys` | Orders, jobs, tick, assets and the worker routes. Not settings, keys, connectors or reconciliation (403). |

Service keys are stored only as hashes and shown once. Several can be active at a time, and each can be revoked with `DELETE /v1/keys/:id`.

## Setup

```bash
A="authorization: Bearer $ADMIN_API_TOKEN"
# Provider credentials: stored encrypted with CONFIG_ENCRYPTION_KEY
curl -X PUT localhost:4020/v1/settings -H "$A" -H 'content-type: application/json' -d '{"key":"GEMINI_API_KEY","value":"..."}'
# Other keys: TEXT_MODEL, IMAGE_MODEL, TELEGRAPH_TOKEN, TELEGRAM_BOT_TOKEN, CALLBACK_URL, CALLBACK_SECRET

curl -X POST localhost:4020/v1/connectors/gemini/probe -H "$A"                  # read-only check; lists models
curl -X POST localhost:4020/v1/keys -H "$A" -d '{"name":"peak-buybot"}' -H 'content-type: application/json'
```

`GET /v1/connectors` lists every source and its status:

- **Live:** DEX Screener, Gemini, Telegraph, Telegram, Binance (through the worker) and Peak.
- **Handoff only:** X, Coinranking and Coinvote. The service prepares the content, and someone submits it by hand.
- **Planned, not built:** Helius, Paragraph and DegenZ.

Probes only read. They never publish anything or spend the order's allowance.

## Orders

Create an order only after the payment is **confirmed** in Peak, and always send the same `order_id`:

```bash
curl -X POST localhost:4020/v1/orders -H "authorization: Bearer $SERVICE_KEY" -H 'content-type: application/json' -d '{
  "order_id": "peak-1001",
  "chain": "solana",
  "contract_address": "So11111111111111111111111111111111111111112",
  "telegram_url": "https://t.me/yourproject",
  "logo_url": "https://example.com/mascot.png",
  "channels": ["telegraph", "telegram"],
  "telegram_chat_id": "@yourchannel",
  "telegram_owner_id": 123456789,
  "approved_facts": [{"type":"kol_campaign","text":"...","source":"https://t.me/yourproject/12","confirmed":true}],
  "budget_cents": 100
}'
```

- **Retries are safe.** Resending the same payload returns the existing order (200). Resending the same `order_id` with a different payload returns 409.
- **Unknown fields are rejected.** Omit absent values rather than sending `null`.
- **Claims are limited to `approved_facts`.** The prompt tells Gemini not to invent releases, budgets, endorsements or price claims. Review early live outputs before scaling.
- **`budget_cents` is an internal planning allowance, not billing.** Copy uses 5 and each image uses 12. When the allowance runs out, the item is `blocked` and no provider call is made.

### Pipeline and statuses

`metadata → copy → hub → campaign_image → media* → telegraph / binance* / telegram → sticker_art_0..4 → stickers* → sticker_publish`

(* = done by the companion worker.)

Publications wait until the campaign image is delivered; if the image can't be generated, they stay queued rather than going out without it. Sticker work waits until every primary item is settled. A background loop (`TICK_INTERVAL_MS`) advances jobs and sends callbacks. To run steps without waiting, call `POST /v1/tick` or `POST /v1/orders/:id/process`.

| Job status | Meaning |
| --- | --- |
| `delivered` | Done. Publications have a verified public URL. |
| `skipped` | Not requested, or a demo order. |
| `blocked` | Missing credential, input or allowance. Doesn't use up an attempt. Fix it, then `POST /v1/jobs/:id/retry`. |
| `failed` | Three attempts used. |
| `uncertain` | A post may exist but couldn't be verified. **Never retried automatically.** Check the account, then `POST /v1/jobs/:id/reconcile {"url": "..."}` (admin). |

The order's overall status is `delivered` only when every job is `delivered` or `skipped`. It is `attention` if any job is blocked, failed or uncertain.

Other routes:

- `GET /v1/orders/:id`
- `GET /v1/orders/by-external-id/:orderId`
- `GET /v1/orders/:id/events`
- `GET /v1/assets/:id` (add `?download` to get it as an attachment)

## Callbacks

Set `CALLBACK_URL` (public HTTPS; redirects are refused) and `CALLBACK_SECRET`. Delivery is at-least-once, with backoff and up to 8 attempts. The signature scheme matches the original, so Peak's existing `verifyCallback` still works:

- `X-Peak-Event-ID`
- `X-Peak-Timestamp`: Unix seconds
- `X-Peak-Signature`: hex HMAC-SHA256 of `timestamp + '.' + rawBody`

The event types are `order.accepted` and `delivery.updated`. `order_id` in the body is this service's order ID.

## Companion worker (`worker/`)

The worker runs next to the bot and handles the work that needs local tools:

- **Media:** eight 1080px meme PNGs and square and vertical H.264 trailers, built with ffmpeg and sharp.
- **Stickers:** five transparent 512px sticker PNGs.
- **Binance Square:** posts the article with the campaign image as its cover through Binance's official `square-post/scripts/post-image.mjs`.

It uses a service key and polls four routes:

- `POST /v1/render/claim`
- `/v1/render/:jobId/complete|fail`
- `POST /v1/publish/claim`
- `/v1/publish/:jobId/complete`

Leases expire, so a crashed worker's job is picked up again. A crashed publication becomes `uncertain` instead.

```bash
cd worker && npm install && cp .env.example .env   # needs ffmpeg + a font such as DejaVu Sans
npm start
npm test                                            # render + callback-signature test
```

For Binance, set `BINANCE_SQUARE_SKILL_DIR` (pinned checkout of `binance/binance-skills-hub` → `skills/binance/square-post`) and `BINANCE_SQUARE_OPENAPI_KEY` on the worker only.

`worker/client.mjs` (`ContentMachineClient`, `verifyCallback`) is the client Peak Buybot should use for intake and polling.

## Public hub

With `PUBLIC_HUB_ENABLED=true`, `GET /projects/:id` serves the project page as HTML, or as JSON when the request sends `Accept: application/json`. Its assets are at `/projects/:id/assets/:assetId`. The hub shows only what the project would publish anyway. It never shows chat IDs, budgets, errors or order input. It is off by default, and in that case `/projects/*` returns 404.

## Tests

- `npm test`: auth and key scope; validation and idempotency; the demo pipeline; the allowance cap; encrypted settings; single-claim leases. It also runs the full live pipeline with providers faked at the HTTP layer: blocked-then-resumed jobs, uncertain Telegraph and Binance posts and their reconciliation, render validation, signed callbacks, the public hub and connector probes.
- `npx tsx test/e2e-worker.ts`: the real server and the real worker (ffmpeg and sharp) talking over HTTP.

## Not yet verified live

Gemini, Telegraph, Telegram and Binance have not been exercised with real credentials. The first paid order should be a low-cost acceptance test with connected accounts.
