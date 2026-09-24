# Content Machine Service

A standalone content microservice. It takes a token order (or a trending purchase) from the buybot and produces and publishes a project content kit:

- **Token details:** name, ticker, logo and market data from DEX Screener.
- **Copy (Gemini):** an article with a headline, a social post (Telegram-sized, ≤800 chars) and a short post (X-sized, ≤280 chars), plus meme captions and trailer lines for the renderer.
- **Artwork (Gemini):** a campaign image and five matching sticker designs.
- **Rendered media:** memes, trailers and sticker PNGs, made by the companion worker.
- **Callbacks:** each status change is sent to the buybot as a signed webhook.

### Destinations

Only these. Every post carries the same campaign image, and nothing counts as delivered until its public URL is confirmed.

| Destination | Content | Status |
| --- | --- | --- |
| Binance Square | Article, campaign image as cover | Live (companion worker) |
| Telegraph | Article, campaign image embedded (needs `PUBLIC_HUB_ENABLED`) | Live |
| Full Send Trenches channel | `🔥 TRENDING` + social post + project Telegram link, with the image | Live (`call_channel`) |
| Telegram sticker pack | Five stickers from the project mascot, owned by our team account (`STICKER_OWNER_ID`); the link goes to the buybot to DM the buyer | Live |
| Reddit r/moonshots and r/solanamemecoins | Headline + article as a text post in each (image link at the top when the hub is public, Telegram link at the end) | Built (companion worker, scripted browser); not yet run against real Reddit |
| CoinSniper | Listing at coinsniper.net/submit | Built (companion worker); not yet run against the real form |
| Coinvote | Listing at coinvote.cc/en/add-coin/released | Built (companion worker); not yet run against the real form |

The short post is the hub summary; it isn't posted anywhere by itself.

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
curl -X POST localhost:4020/v1/keys -H "$A" -d '{"name":"buybot"}' -H 'content-type: application/json'
```

`GET /v1/connectors` lists the inputs (DEX Screener, Gemini, order intake) and the destinations above, with each one's setup status. The four unbuilt destinations are listed as `planned`.

Probes only read. They never publish anything or spend the order's allowance.

## Orders

Create an order only after the payment is **confirmed** in the buybot, and always send the same `order_id`:

```bash
curl -X POST localhost:4020/v1/orders -H "authorization: Bearer $SERVICE_KEY" -H 'content-type: application/json' -d '{
  "order_id": "order-1001",
  "chain": "solana",
  "contract_address": "So11111111111111111111111111111111111111112",
  "telegram_url": "https://t.me/yourproject",
  "logo_url": "https://example.com/mascot.png",
  "channels": ["telegraph", "binance", "call_channel"],
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

`metadata → copy → hub → campaign_image → media* → telegraph / binance* / call_channel / reddit_moonshots* / reddit_solanamemecoins* / coinsniper* / coinvote* → sticker_art_0..4 → stickers* → sticker_publish`

(* = done by the companion worker.)

Publications wait until the campaign image is delivered; if the image can't be generated, they stay queued rather than going out without it. Sticker work waits until the in-service primary items are settled (it doesn't wait on Binance or Reddit). A background loop (`TICK_INTERVAL_MS`) advances jobs and sends callbacks. To run steps without waiting, call `POST /v1/tick` or `POST /v1/orders/:id/process`.

| Job status | Meaning |
| --- | --- |
| `delivered` | Done. Publications have a verified public URL. |
| `skipped` | Not requested, or a demo order. |
| `blocked` | Missing credential, input or allowance. Doesn't use up an attempt. Fix it, then `POST /v1/jobs/:id/retry`. |
| `failed` | Three attempts used (or a listing was still not live a week after submission). |
| `submitted` | A directory listing is waiting for the site's review. The order shows `in_review` while this is all that's left. |
| `uncertain` | A post may exist but couldn't be verified. **Never retried automatically.** Check the account, then `POST /v1/jobs/:id/reconcile {"url": "..."}` (admin). |

The order's overall status is `delivered` only when every job is `delivered` or `skipped`. It is `attention` if any job is blocked, failed or uncertain.

Other routes:

- `GET /v1/orders/:id`
- `GET /v1/orders/by-external-id/:orderId`
- `GET /v1/orders/:id/events`
- `GET /v1/assets/:id` (add `?download` to get it as an attachment)

## Trending purchases → call channel

After a **confirmed** trending purchase, the buybot calls:

```bash
curl -X POST localhost:4020/v1/trending -H "authorization: Bearer $SERVICE_KEY" -H 'content-type: application/json' -d '{
  "purchase_id": "8841",
  "chain": "solana",
  "contract_address": "So11111111111111111111111111111111111111112",
  "telegram_url": "https://t.me/yourproject",
  "name": "Moon Frog", "symbol": "MFROG",
  "logo_url": "https://example.com/mascot.png"
}'
```

- **What it creates:** an order with ID `trending:<purchase_id>` that always includes the `call_channel` post. Add `channels` to publish anywhere else too.
- **Retries are safe:** resending the same `purchase_id` returns the same order.
- **Extra fields are ignored:** the buybot can send its whole purchase record.
- **Order of work:** the post goes out after the copy and campaign image exist, as one photo message. The caption is:

  ```
  🔥 TRENDING | Moon Frog ($MFROG)

  <X-sized post>

  💬 Telegram: https://t.me/yourproject
  ```

**Setup:**

1. In @BotFather, revoke any token that has been shared and use the replacement.
2. Make the bot an admin of the channel, with permission to post messages.
3. Save the settings: `CALL_CHANNEL_BOT_TOKEN` and `CALL_CHANNEL_ID` (e.g. `@fullsendtrenches`). `CALL_CHANNEL_LABEL` is optional and changes the first line.
4. Check with `POST /v1/connectors/call_channel/probe`. It confirms the bot can post in the channel, without posting anything.

The call-channel bot is separate from `TELEGRAM_BOT_TOKEN`. If a send fails partway, the job is `uncertain` and is never re-posted automatically.

## Callbacks

Set `CALLBACK_URL` (public HTTPS; redirects are refused) and `CALLBACK_SECRET`. Delivery is at-least-once, with backoff and up to 8 attempts. Verify with `verifyCallback` from `worker/client.mjs`:

- `X-Event-ID`
- `X-Timestamp`: Unix seconds
- `X-Signature`: hex HMAC-SHA256 of `timestamp + '.' + rawBody`

The event types are `order.accepted`, `delivery.updated` and `sticker_pack.ready` (`data.url` is the `t.me/addstickers/...` link for the buybot to DM to the buyer). Each body carries `order_id` (this service's ID) and `external_order_id` (the buybot's `order_id`, or `trending:<purchase_id>`).

## Companion worker (`worker/`)

The worker runs next to the bot and handles the work that needs local tools:

- **Media:** eight 1080px meme PNGs and square and vertical H.264 trailers, built with ffmpeg and sharp.
- **Stickers:** five transparent 512px sticker PNGs.
- **Binance Square:** posts the article with the campaign image as its cover through Binance's official `square-post/scripts/post-image.mjs`.
- **Reddit:** logs in once with `REDDIT_USERNAME` / `REDDIT_PASSWORD` (session saved to `REDDIT_STATE_PATH`), submits a text post through old.reddit's submit form, reads back the post URL, and re-opens it logged-out to confirm it is visible. Login failures, CAPTCHAs and Reddit's "doing that too much" limit are reported as *not posted* and retried after 5 minutes; anything after the submit click that can't be confirmed becomes `uncertain`. It does not try to get around CAPTCHAs or bot checks, and Reddit's rules don't allow automating the website, so use an account you can afford to lose.

- **Directory listings (CoinSniper, Coinvote):** logs in with that site's account (session saved in `DIRECTORY_STATE_DIR`), fills the submit form by matching each field's label (name, symbol, chain, contract, launch date, description, website, Telegram, X, logo upload, terms box), and submits. Any required field it can't fill stops the job *before* submitting, with a screenshot and the page's HTML in `DIRECTORY_DEBUG_DIR`. After submitting, the job is `submitted`; every hour the worker checks the site logged-out (the returned coin URL, else the new-coins page) and delivers the coin page URL once it's live. `npm run inspect coinsniper` (or `coinvote`) logs in and prints each form field and what would go in it, without submitting.

It uses a service key and polls these routes:

- `POST /v1/render/claim`
- `/v1/render/:jobId/complete|fail`
- `POST /v1/publish/claim`
- `/v1/publish/:jobId/complete|fail` (claim takes `{"kinds": [...]}`: `binance`, `reddit_moonshots`, `reddit_solanamemecoins`, `coinsniper`, `coinvote`)
- `POST /v1/listings/check-claim`, `/v1/listings/:jobId/checked`

Leases expire, so a crashed worker's job is picked up again. A crashed publication becomes `uncertain` instead.

```bash
cd worker && npm install && cp .env.example .env   # needs ffmpeg + a font such as DejaVu Sans
npm start
npm test                                            # render, callback signature, Reddit and directory flows against local fakes
```

For Binance, set `BINANCE_SQUARE_SKILL_DIR` (pinned checkout of `binance/binance-skills-hub` → `skills/binance/square-post`) and `BINANCE_SQUARE_OPENAPI_KEY` on the worker only.

`worker/client.mjs` (`ContentMachineClient`, `verifyCallback`) is the client the buybot should use for intake and polling.

## Deploy on Railway

Two services from this repo, each with **Root Directory** set in Railway and a **volume mounted at `/data`**:

| Service | Root directory | What it needs |
| --- | --- | --- |
| API | `content-machine-service` | Public domain (Settings → Networking → Generate Domain). Healthcheck `/health`. |
| Worker | `content-machine-service/worker` | No domain. Chromium, ffmpeg and the pinned Binance scripts are baked into its image. |

**API variables:** `ADMIN_API_TOKEN`, `CONFIG_ENCRYPTION_KEY` (never change it once set), `PUBLIC_BASE_URL=https://<the generated domain>`, `PUBLIC_HUB_ENABLED=true`, `STICKER_OWNER_ID`, `CALL_CHANNEL_ID=@fullsendtrenches`. Secrets (Gemini, Telegraph, the bot token, callback URL and secret) can be Railway variables too, or saved afterwards with `PUT /v1/settings`. Railway provides `PORT`.

**Worker variables:** `CONTENT_MACHINE_URL` (the API's public URL, or `http://<api-service>.railway.internal:<PORT>` over private networking), `CONTENT_MACHINE_API_KEY` (issue one with `POST /v1/keys`), `BINANCE_SQUARE_OPENAPI_KEY`, `REDDIT_USERNAME`, `REDDIT_PASSWORD`, `COINSNIPER_EMAIL`, `COINSNIPER_PASSWORD`, `COINVOTE_EMAIL`, `COINVOTE_PASSWORD`.

Then check the setup with the connector probes: `GET /v1/connectors`, and `POST /v1/connectors/{gemini|telegraph|call_channel|sticker_pack}/probe`.

## Public hub

With `PUBLIC_HUB_ENABLED=true`, `GET /projects/:id` serves the project page as HTML, or as JSON when the request sends `Accept: application/json`. Its assets are at `/projects/:id/assets/:assetId`. The hub shows only what the project would publish anyway. It never shows chat IDs, budgets, errors or order input. It is off by default, and in that case `/projects/*` returns 404.

## Tests

- `npm test`: auth and key scope; validation and idempotency; the demo pipeline; the allowance cap; encrypted settings; single-claim leases. It also runs the full live pipeline with providers faked at the HTTP layer: blocked-then-resumed jobs, uncertain Telegraph and Binance posts and their reconciliation, render validation, signed callbacks, the public hub and connector probes.
- `worker`: `npm test` runs the renderer, the Binance cover-image publish and the Reddit script against a local fake Reddit (set `CHROMIUM_PATH` if Playwright's own Chromium isn't installed).
- `npx tsx test/e2e-worker.ts`: the real server and the real worker (ffmpeg and sharp) talking over HTTP.

## Not yet verified live

Gemini, Telegraph, Telegram and Binance have not been exercised with real credentials. The first paid order should be a low-cost acceptance test with connected accounts.
