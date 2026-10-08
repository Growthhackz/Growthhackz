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
| CoinMarketCap community (`cmc_community`) | Social post + campaign image from our CMC profile's compose icon; verified on its public `coinmarketcap.com/community/post/<id>/` page | Built (companion worker); login, composer and image input checked on the real site, no real post made yet |
| 1888PressRelease (`press_1888`) | Press release built from the article (headline ≤ 22 words, 750+ character plain-text body with the contract address), submitted through the form and its preview step; delivered once the release page is live | Built (companion worker); login and form fields checked on the real site, not yet submitted |

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

## Trending flow

A trending purchase (`POST /v1/trending`) becomes one order. Its items run on their own and wait only on what they need:

```
1a  metadata → copy (article, social post, X post) → campaign image      content
1b  social_boost: WURK $1 small raid on x_post_url                       starts at once, needs nothing
2a  telegraph · binance · call_channel · coinsniper · coinvote ·           each needs the campaign image
    cmc_community · press_1888 (· reddit, on hold)
3a  sticker art → stickers → sticker pack                                 needs only the copy
4   order.completed callback + GET /v1/orders/:id/report                  once every item is final (listings: once submitted with their URL)
```

- **Channels:** every trending order gets `TRENDING_CHANNELS` (default: `telegraph,binance,call_channel,top100token,gemfinder,freshcoins,coinscope,cmc_community,social_boost,bitcointalk,meme_pack`; CoinSniper and Coinvote are off because their submissions don't go through, Reddit is on hold) plus any the buybot sends.
- **Links:** the copy is written without links. Every post gets the project's Telegram link, and articles (Telegraph, Binance, Reddit, press release) also get X and the website.
- **Paused channels:** `PAUSED_CHANNELS` (default `call_channel`) switches channels off for every order, even when the buybot asks for them.
- **Repeat purchases:** a trending purchase for a token that already has trending orders is numbered (`project.purchase_number`) and gets only `REPEAT_CHANNELS` (default: CMC and Binance posts, the social boost and the meme pack) plus five new stickers. Its copy is about the team that keeps marketing and building, and is given the earlier posts so nothing repeats; memes use templates the token hasn't had and avoid its earlier captions; stickers get the next five captions and are added to the token's existing pack (`t.me/addstickers/<TICKER>_by_<bot>`; a new pack once it holds 120). Titles: "Back in the Spotlight", "Still Building", "Full Steam Ahead", …
- **Social boost:** calls social-activity-service (`SOCIAL_ACTIVITY_URL`, `SOCIAL_ACTIVITY_TOKEN`) to create a bundled WURK package (`SOCIAL_BOOST_PRESET`: `trending` by default, the $1 small raid plus 50 X followers and 50 Telegram members, $4.00; `small_raid` is the raid alone; `full` is saved for later) and marks it paid by the trending purchase. The call is idempotent per order. It is delivered once WURK has accepted the job (the report shows its job link). If the social service is down, the boost keeps retrying until its deadline and nothing else waits on it. With no `x_post_url` in the purchase it is skipped.
- **Deadlines:** each item fails automatically when its time runs out. It's measured from the order, or from an admin retry.

  | Item | Deadline |
  | --- | --- |
  | metadata / copy / hub / campaign image | 1h / 2h / 2h / 3h |
  | Telegraph, call channel | 6h |
  | Binance, CMC, Reddit | 12h |
  | CoinSniper, Coinvote, 1888 (including the site's review) | 8 days |
  | sticker art / stickers / sticker pack | 6h / 8h / 10h |
  | social boost | 24h |

  A running item is never cut off mid-run, and `uncertain` items (possibly published) are left for reconciliation. When an item fails, everything that depends on it fails straight away with `Not started: <item> failed` instead of waiting out its own deadline.
- **Report:** `GET /v1/orders/:id/report` (or `/v1/orders/by-external-id/trending:<purchase_id>/report`) returns three lists: `successes` (source, label, public URL), `failures` (source, label, reason; `unconfirmed` for possibly-published items) and `pending` (status, deadline, current problem). When every item is final, the same report goes to `CALLBACK_URL` as a signed `order.completed` event. A listing that was submitted with its coin page URL counts as final for this (the site's review can take days): it is in `successes` labelled "(in review)". Listing requests with no public page until the site approves them (CoinCodex, CNToken, Blockspot, OKX Wallet, Bitget Wallet) are labelled "(submitted, in review)"; their URL is a screenshot of the submission (the site's confirmation, or Bitget's "Under review" list), and the job result also keeps `review_url`, the site's own page to follow up on. An admin can attach proof captured later with `POST /v1/jobs/:id/proof {"proof": "<base64 JPEG/PNG>", "review_url": "..."}` (for OKX/Bitget, `node worker/wallets.mjs proof <okx_wallet|bitget_wallet> out.jpg` takes it read-only). An admin retry reopens the order, and it reports again when it finishes.

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

`metadata → copy → hub → campaign_image → media* → telegraph / binance* / call_channel / reddit_moonshots* / reddit_solanamemecoins* / coinsniper* / coinvote* / cmc_community* / press_1888* → sticker_art_0..4 → stickers* → sticker_publish`

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
- **Reddit:** uses the session from `REDDIT_COOKIES` (a JSON cookie export from a browser that is logged in to Reddit; installed once per export and refreshed by the worker after each post) or logs in with `REDDIT_USERNAME` / `REDDIT_PASSWORD` (session saved to `REDDIT_STATE_PATH`). On start the worker logs which account it is logged in as. With cookies only, an expired session is reported as *not posted* until a fresh export is set. submits a text post through old.reddit's submit form, reads back the post URL, and re-opens it logged-out to confirm it is visible. Login failures, CAPTCHAs and Reddit's "doing that too much" limit are reported as *not posted* and retried after 5 minutes; anything after the submit click that can't be confirmed becomes `uncertain`. It does not try to get around CAPTCHAs or bot checks, and Reddit's rules don't allow automating the website, so use an account you can afford to lose.

- **Directory listings (CoinSniper, Coinvote):** logs in with that site's account (session saved in `DIRECTORY_STATE_DIR`), fills the submit form by matching each field's label (name, symbol, chain, contract, launch date, description, website, Telegram, X, logo upload, terms box), and submits. Any required field it can't fill stops the job *before* submitting, with a screenshot and the page's HTML in `DIRECTORY_DEBUG_DIR`. After submitting, the job is `submitted`; every hour the worker checks the site logged-out (the returned coin URL, else the new-coins page) and delivers the coin page URL once it's live. `npm run inspect coinsniper` (or `coinvote`) logs in and prints each form field and what would go in it, without submitting.
- **Bitcointalk:** posts one thread per order in Altcoin Discussion (`BTCTALK_BOARD`, default 67) from the saved session in `BTCTALK_COOKIES` (a cookie export from a browser logged in with "Always stay logged in"; login itself has a captcha, so there is no password login). Title and body come from the copy's forum-style thread, with the project links at the end. The worker then opens the thread logged-out to confirm it. Bitcointalk's time limit between posts, an expired session or a captcha on the post form are reported as *not posted* and retried later. On start the worker logs which member the session is logged in as.
- **Firecrawl browser (CoinSniper, Coinvote):** with `FIRECRAWL_API_KEY` set, the directory flows drive a Firecrawl browser session over CDP instead of a local Chromium, so their traffic leaves through Firecrawl's proxy (`FIRECRAWL_PROXY`, default `enhanced`) and `DIRECTORY_PROXY` isn't used. `FIRECRAWL_SITES` picks the sites (default `coinsniper,coinvote`). Each site's login lives in a Firecrawl profile (`FIRECRAWL_PROFILE_PREFIX`-<site>, default `cm-coinsniper` / `cm-coinvote`): run `npm run login coinsniper` (or `coinvote`), open the printed live-view link, log in by hand (including any captcha) and open the submit page; the profile is saved when the session stops. Don't run it while the worker is using the same site. A session starts on the submit page and uses that tab, because Cloudflare can block a later navigation in the session. Without a logged-in profile (or `<SITE>_EMAIL` / `<SITE>_PASSWORD`) a listing is reported as *not posted*. Firecrawl refuses Reddit, so Reddit always uses a local browser with `REDDIT_PROXY`. Cost: 1 credit per session start plus 2 credits per browser minute.
- **CoinMarketCap community:** opens our profile (`CMC_PROFILE_HANDLE`, default `peakbuybot`), logs in with `CMC_EMAIL` / `CMC_PASSWORD` if the saved session (`CMC_STATE_PATH`, default in `DIRECTORY_STATE_DIR`) has expired, clicks the compose icon beside "All Posts", types the social post plus the Telegram link, attaches the campaign image and clicks Post. The post ID comes from CMC's own API response (or the newest matching post on the profile), and the service confirms the public post page before delivering it. A human check, an email verification code or a failed login is reported as *not posted*; anything after the Post click that can't be confirmed becomes `uncertain`.
- **1888PressRelease:** logs in with `PRESS1888_USERNAME` / `PRESS1888_PASSWORD`, fills the free submission form (company `PRESS1888_COMPANY`, which must already exist on the account; contact `PRESS_CONTACT_NAME` / `PRESS_CONTACT_EMAIL`, optional `PRESS_CONTACT_PHONE` / `PRESS_CONTACT_ZIP`; category Banking & Financial, type General Press Release), goes through the preview page and clicks the final submit. The form's own validation alerts, a missing company or a preview page without a submit button stop it *before* anything is sent. After submitting, the job is `submitted`; the worker checks 1888's public daily news pages each hour and delivers the `…-pr-<id>.html` URL once the release is live (it fails after a week in review).

It uses a service key and polls these routes:

- `POST /v1/render/claim`
- `/v1/render/:jobId/complete|fail`
- `POST /v1/publish/claim`
- `/v1/publish/:jobId/complete|fail` (claim takes `{"kinds": [...]}`: `binance`, `reddit_moonshots`, `reddit_solanamemecoins`, `coinsniper`, `coinvote`, `cmc_community`, `press_1888`; `/v1/listings/check-claim` takes the same `{"kinds": [...]}`)
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

**Worker variables:** `CONTENT_MACHINE_URL` (the API's public URL, or `http://<api-service>.railway.internal:<PORT>` over private networking), `CONTENT_MACHINE_API_KEY` (issue one with `POST /v1/keys`), `BINANCE_SQUARE_OPENAPI_KEY`, `REDDIT_USERNAME`, `REDDIT_PASSWORD`, `COINSNIPER_EMAIL`, `COINSNIPER_PASSWORD`, `COINVOTE_EMAIL`, `COINVOTE_PASSWORD`, `CMC_EMAIL`, `CMC_PASSWORD`, `CMC_PROFILE_HANDLE`, `PRESS1888_USERNAME`, `PRESS1888_PASSWORD`, `PRESS1888_COMPANY`, `PRESS_CONTACT_NAME`, `PRESS_CONTACT_EMAIL`, `FIRECRAWL_API_KEY`, `FIRECRAWL_PROXY`, `FIRECRAWL_SITES`, `FIRECRAWL_PROFILE_PREFIX`.

Then check the setup with the connector probes: `GET /v1/connectors`, and `POST /v1/connectors/{gemini|telegraph|call_channel|sticker_pack}/probe`.

## Public hub

With `PUBLIC_HUB_ENABLED=true`, `GET /projects/:id` serves the project page as HTML, or as JSON when the request sends `Accept: application/json`. Its assets are at `/projects/:id/assets/:assetId`. The hub shows only what the project would publish anyway. It never shows chat IDs, budgets, errors or order input. It is off by default, and in that case `/projects/*` returns 404.

## Tests

- `npm test`: auth and key scope; validation and idempotency; the demo pipeline; the allowance cap; encrypted settings; single-claim leases. It also runs the full live pipeline with providers faked at the HTTP layer: blocked-then-resumed jobs, uncertain Telegraph and Binance posts and their reconciliation, render validation, signed callbacks, the public hub and connector probes.
- `worker`: `npm test` runs the renderer, the Binance cover-image publish and the Reddit script against a local fake Reddit (set `CHROMIUM_PATH` if Playwright's own Chromium isn't installed).
- `npx tsx test/e2e-worker.ts`: the real server and the real worker (ffmpeg and sharp) talking over HTTP.

## Not yet verified live

Gemini, Telegraph, Telegram and Binance have not been exercised with real credentials. The first paid order should be a low-cost acceptance test with connected accounts.


## Self-healing

Problems are fixed automatically where that is safe. Admins (`ASSIST_CHAT_ID`, else `STICKER_OWNER_ID`) get a Telegram message only when a person is needed (🔴, with what to do), and the same message at most once every 12 hours. 🟡 caught and ✅ fixed are written to the API log only; `ADMIN_NOTIFY=all` sends them too. The proxy never alerts on its own: the worker goes direct, and a site alerts if it breaks.

- **Sources:** a failed health check is rechecked every 5 minutes instead of 30; the CMC and GemFinder checks log in again and save the session. After 3 failed attempts in a row the source is escalated (🔴).
- **Content steps** (copy, images, memes, sticker art, renders): a step that failed its attempts gets one more run after 10 minutes, with everything that failed only because of it. If retries used up the order's generation allowance it gets a one-time top-up (`HEAL_BUDGET_CENTS`, default 150). A second failure is escalated.
- **Uncertain publications** (CMC post, GemFinder listing): 10 minutes later the worker looks on our account. Found: the link is recorded. Our list loaded and it isn't there: it is posted again. The account page didn't load 3 times: escalated.
- **Worker container:** the worker runs under `tini`, which reaps exited browser processes. If the container still runs out of processes or memory (`EAGAIN`, `ENOMEM`, Chromium crashing at launch, or more than 100 unreaped processes), the worker restarts itself and Railway brings it back. A browser that never started counts as "nothing was sent", so the item is retried rather than left uncertain. A failed render reports its real error. Admins can reset the attempts on a failed content step (`reset_attempts`), because it publishes nothing.
- **Ops agent:** a scheduled Claude Code session reads `/v1/health/sources` and `/v1/errors` every hour; for a problem the automatic fixes don't cover it changes the code, runs the tests, merges, deploys, checks the result and reports through `POST /v1/ops/notify`.
- `SELF_HEAL_ENABLED=false` turns the automatic fixes off.

## Keeping sources up (health checks)

Every 30 minutes the worker checks each site it posts to and the API checks its own keys, bots and the WURK wallet (`GET /v1/health/sources`, `POST /v1/health/run`). A failed check is retried once before it counts. Each change between working and broken is sent to `ASSIST_CHAT_ID` (else `STICKER_OWNER_ID`) on Telegram: 🔴 with what to fix, 🟢 when it works again. The CMC and GemFinder checks also log in again when their session lapsed, which keeps those logins fresh between orders.

| Source | What keeps it working | Checked by | When it breaks |
|---|---|---|---|
| CoinMarketCap | `CMC_COOKIES` + `CMC_EMAIL` / `CMC_PASSWORD` (the worker re-logs in and saves fresh cookies to `/data`), residential `DIRECTORY_PROXY` | profile shows our Edit button | log in once in a normal browser and export fresh `CMC_COOKIES` (a human check at login is not bypassed) |
| Bitcointalk | `BTCTALK_COOKIES` (`SMFCookie…`, "stay logged in"; current one expires 2027-11) | logged-in username | export fresh cookies from a logged-in browser |
| Binance Square | `BINANCE_SQUARE_OPENAPI_KEY` + the Square skill in the image | key and script present | new OpenAPI key |
| Top100Token | no login | submit form loads | usually Cloudflare; clears by itself |
| GemFinder | `GEMFINDER_EMAIL` / `GEMFINDER_PASSWORD` | logged in, add-coin form loads | check the password |
| FreshCoins | `FRESHCOINS_COOKIES` (Google login; `__client` cookie lasts a year) | add-coin form loads | export fresh cookies from a logged-in browser |
| Coinscope | `COINSCOPE_REFRESH_TOKEN` (Google login) | token mints a login | sign in again and copy the new refresh token |
| Gemini, sticker bot, Telegraph | API keys / tokens | key works, `getMe`, token valid | replace the key or token |
| WURK | wallet key + `WURK_LIVE_PAYMENTS_ENABLED`, USDC balance | live and at least `WURK_LOW_BALANCE_USDC` (20) USDC | top up the wallet |
| Worker | `content-machine-worker` running | polled the API in the last 10 min | redeploy the worker |
