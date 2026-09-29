# Core bot ↔ Content Machine integration (prompt for the core bot)

You are working on the **core bot**, the Telegram trending/buy bot. Add a two-way integration with the
**Content Machine** API. Once a user pays for trending, the Content Machine writes and publishes the
campaign: articles, the call-channel post, listings, press, the X raid and a Telegram sticker pack. It
reports each live link back as soon as it exists. Your job:

1. **Outbound:** right after a trending payment is confirmed, send us the coin's structured data.
2. **Inbound:** run a small, locked-down webhook receiver. It accepts signed events from the Content
   Machine only, and DMs each published link to the buyer in the bot so they can share it and follow
   progress.

Security is the top priority on both sides. Treat everything below as requirements, not suggestions.

---

## 0. Secrets and configuration

The following are provided separately. They must never be committed, logged, echoed to users or put
in error messages. Store them as environment variables:

| Variable | Purpose |
|---|---|
| `CONTENT_MACHINE_URL` | `https://content-machine-api-production-509a.up.railway.app` |
| `CONTENT_MACHINE_INTAKE_KEY` | Bearer key (`pk_…`). It can only create trending orders and read their status and report. |
| `CONTENT_MACHINE_CALLBACK_SECRET` | HMAC secret that signs every event we send you. |
| `CONTENT_MACHINE_WEBHOOK_PATH` | An unguessable path for your receiver, e.g. `/hooks/content-machine/<32 random hex>`. |

When your receiver is live, send us its full public HTTPS URL, including the random path. We register
it on our side. It must be `https://` on the standard port, with a public hostname and no IP literal.

---

## 1. Outbound: send the order immediately after payment

As soon as a trending payment is **confirmed on-chain** (not merely initiated), call:

```
POST {CONTENT_MACHINE_URL}/v1/trending
Authorization: Bearer {CONTENT_MACHINE_INTAKE_KEY}
Content-Type: application/json
```

### Body

| Field | Required | Rules |
|---|---|---|
| `purchase_id` | yes | Your unique ID for this payment. Use only `[A-Za-z0-9_-]`, up to 100 characters. It is the idempotency key. |
| `chain` | yes | One of `solana`, `ethereum`, `base`, `bsc`, `polygon`, `arbitrum`. |
| `contract_address` | yes | The token CA, 20–64 characters. |
| `name` | no* | Token name, up to 80 characters. |
| `symbol` | no* | Ticker without `$`, up to 20 characters. |
| `telegram_url` | no | The project's `https://t.me/...` link. |
| `x_url` | no | The project's X profile, `https://x.com/<handle>`. |
| `x_post_url` | no | The X post to raid, `https://x.com/<user>/status/<id>`. Without it the X raid is skipped. |
| `website_url` | no | HTTPS only. |
| `logo_url` | no | HTTPS image URL (PNG/JPG) of the coin's logo. **Send it whenever the coin has one.** The sticker pack and campaign art are drawn from it; with no logo there is no sticker pack. |
| `description` | no | Up to 2500 characters, the project's own description. |
| `telegram_owner_id` | no | Numeric Telegram user ID of the buyer, for our records only. It doesn't change what we publish (see §3 on sticker packs). |
| `launch_date` | no | `YYYY-MM-DD`. |

\* Send the name and symbol whenever you have them. If you don't, we look them up from the DEX.

Other rules for the body:
- **Only send socials the project actually has.** Omit a field rather than sending an empty string,
  `null`, a placeholder or a guessed link. Every URL must be `https://`.
- Don't send `channels`. We use our default set of destinations.
- Unknown fields are ignored, but keep the body to the fields above.

Example:

```json
{
  "purchase_id": "tp_8f3a2c91",
  "chain": "solana",
  "contract_address": "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr",
  "name": "Moon Frog",
  "symbol": "MFROG",
  "telegram_url": "https://t.me/moonfrog",
  "x_url": "https://x.com/moonfrog",
  "x_post_url": "https://x.com/moonfrog/status/1840000000000000000",
  "website_url": "https://moonfrog.xyz",
  "logo_url": "https://cdn.example.com/moonfrog.png",
  "telegram_owner_id": 123456789
}
```

### Responses

| Status | Meaning | What to do |
|---|---|---|
| `201` | Order created. | Store the mapping (see §3). Only `id` and `order_id` in the response body matter; ignore the rest. |
| `200` | This `purchase_id` already has an order; it returns the existing one. | Treat as success. |
| `400` | Validation error; `error.message` says which field. | Don't retry unchanged. Fix the data or alert an admin. |
| `401` / `403` | Bad key, or a route the key isn't allowed to use. | Alert an admin; don't retry in a loop. |
| `429` / `5xx` / timeout | Temporary. | Retry. |

### Delivery guarantees

- Send from a **persistent outbox** (a DB row per payment), not fire-and-forget. A crash or deploy
  must not lose an order.
- Retry `429`, `5xx` and network errors with exponential backoff: 5s, 15s, 1m, 5m, 15m, then every
  30 minutes for up to 24 hours. Mark the row done on `200` or `201`. Retrying with the same
  `purchase_id` is always safe, because it never creates a second order.
- Use a 15-second request timeout.
- Never put the key in a URL or a log line. Redact the `Authorization` header in any request logging.

### What happens after you send it

Links arrive as each destination goes live, not all at once. Typical timing:

| When | What |
|---|---|
| Seconds | `order.accepted` |
| Minutes to ~1 hour | Telegraph article, call-channel post, X raid, project page |
| A few hours | Binance Square, CoinMarketCap community post, Bitcointalk thread, sticker pack |
| Up to ~8 days | CoinSniper and Coinvote listings, 1888PressRelease (each is reviewed by the site before it goes live) |

Each destination has its own deadline. If one can't be published, it's reported as failed without
holding up the others. `order.completed` arrives only once every item has finished or failed, so it
can come days after the first links.

### Reading status (optional; the webhook is the main channel)

```
GET {CONTENT_MACHINE_URL}/v1/orders/by-external-id/trending:{purchase_id}/report
Authorization: Bearer {CONTENT_MACHINE_INTAKE_KEY}
```

The response looks like this:

```json
{ "order_id": "trending:tp_8f3a2c91", "complete": false,
  "project": { "name": "...", "symbol": "...", "chain": "...", "contract_address": "..." },
  "successes": [{ "source": "telegraph", "label": "Telegraph article", "url": "https://..." }],
  "failures":  [{ "source": "...", "label": "...", "status": "failed|unconfirmed", "error": "..." }],
  "pending":   [{ "source": "...", "label": "...", "status": "...", "deadline_at": "...", "note": "..." }] }
```

Use it for a `/status` button, or to rebuild a user's link list if you missed events. Error text in this
response is internal; **never show it to users**.

The intake key can call only `POST /v1/trending`, `GET /v1/orders/by-external-id/trending:{id}` and
`GET /v1/orders/by-external-id/trending:{id}/report`. Everything else returns `403` by design.

---

## 2. Inbound: the webhook receiver

We `POST` JSON events to your registered URL. **Assume the URL is public and that anyone can hit it.**
Only a request that passes every check below may have any effect.

### Request format

```
POST <your registered URL>
Content-Type: application/json
X-Event-ID: <unique event id>
X-Timestamp: <unix seconds>
X-Signature: <hex HMAC-SHA256(CONTENT_MACHINE_CALLBACK_SECRET, X-Timestamp + "." + raw_body)>
```

Body envelope:

```json
{
  "id": "<same as X-Event-ID>",
  "type": "order.accepted | link.published | sticker_pack.ready | order.completed",
  "order_id": "<our internal id>",
  "external_order_id": "trending:<purchase_id>",
  "purchase_id": "<your purchase_id>",
  "created": 1790000000000,
  "data": { ... }
}
```

`created` is when the event happened, in milliseconds since the epoch.

### Event types (these four only; ignore anything else with `204`)

- **`order.accepted`**: `data: {}`. We have the order. Optionally DM "Your campaign is being built…".
- **`link.published`**: one link is live. Most events are this type.
  ```json
  { "source": "telegraph", "label": "Telegraph article", "url": "https://telegra.ph/...",
    "project": { "name": "Moon Frog", "symbol": "MFROG" } }
  ```
  `source` is one of:
  - `telegraph`
  - `binance`
  - `call_channel`
  - `coinsniper`
  - `coinvote`
  - `cmc_community`
  - `press_1888`
  - `bitcointalk`
  - `social_boost` (the X raid; its URL is the raid's wurk.fun job page)
  - `reddit_moonshots`
  - `reddit_solanamemecoins`
  - `hub` (the project page on our API domain)
- **`sticker_pack.ready`**: the pack is published.
  ```json
  { "url": "https://t.me/addstickers/p1a2b3c..._by_Fullsendtrenchesbot", "name": "p1a2b3c..._by_Fullsendtrenchesbot",
    "project": { "name": "Moon Frog", "symbol": "MFROG" } }
  ```
  This is the only event for the sticker pack; it never appears in `link.published`.
- **`order.completed`**: every item has reached a final state.
  ```json
  { "complete": true, "project": {...},
    "successes": [{ "source": "...", "label": "...", "url": "https://..." }],
    "failures":  [{ "source": "...", "label": "...", "status": "failed|unconfirmed" }],
    "pending":   [] }
  ```
  In `successes`, `source` can also be `sticker_publish` (label "Telegram sticker pack"), and `url`
  can be `null`. Show a success without a URL as a plain ✅ line.

### Delivery behaviour

- Reply with any `2xx` to acknowledge; `204` counts. Anything else, or no reply within **8 seconds**,
  is retried with backoff: 30s, 1m, 2m, 4m… capped at 1 hour, up to 8 attempts (about 2 hours in all).
- **We don't follow redirects.** The registered URL must answer directly. No http→https hop, no
  trailing-slash redirect, and no auth or login redirect in front of it.
- Events for one order usually arrive in order, but retries can reorder them. For example, a
  `link.published` can land after `order.completed`. Don't assume an order; dedupe handles it.

### Verification: run these steps in order and reject on the first failure

1. **Method and path.** Accept only `POST` on exactly `CONTENT_MACHINE_WEBHOOK_PATH`. Return `404` for
   anything else.
2. **Size.** Read the raw body with a hard cap of **64 KB**. Abort with `413` beyond that and never
   buffer more. Keep the connection read timeout at 10 seconds or less.
3. **Content type.** It must be `application/json`. Otherwise return `415`.
4. **Headers.** `X-Event-ID` must match `^[A-Za-z0-9_-]{8,64}$`. `X-Timestamp` must be all digits.
   `X-Signature` must be exactly 64 lowercase hex characters. Otherwise return `401`.
5. **Freshness.** Require `|now − X-Timestamp| ≤ 300` seconds. Otherwise return `401`.
6. **Signature.** Compute `HMAC-SHA256(secret, X-Timestamp + "." + raw_body_bytes)` as hex over the
   **raw bytes exactly as received**, before any JSON parsing. Compare with a **constant-time**
   function such as `crypto.timingSafeEqual` or `hmac.compare_digest`. On mismatch return `401` with
   no detail.
7. **Parse** the JSON only now. Reject non-objects, and bodies whose `id` ≠ `X-Event-ID`.
8. **Replay and dedupe.** Store `X-Event-ID` with a unique constraint and keep it for at least 7 days.
   If it's already stored, return `200` and do nothing. We deliver **at least once** and retry for
   hours, so duplicates are normal.
9. **Strict schema.** Validate `data` against the exact shape for its `type`, using zod, pydantic or
   similar. Drop unknown keys. Limits:
   - `label` and `name`: plain strings of 100 characters or fewer.
   - `symbol`: 20 characters or fewer.
   - `source`: must be from the lists above.
   - `purchase_id`: `^[A-Za-z0-9_-]{1,100}$` and must match a purchase **you** created.

   An unknown purchase gets `200` and is ignored; don't reveal which purchases exist.
10. **URL allowlist.** For every URL you might show (`url`, `successes[].url`), require all of:
    - Length ≤ 500, parses as a URL, protocol exactly `https:`.
    - No username or password, and no port other than the default.
    - Hostname (lowercased) is exactly one of, or a subdomain of, this allowlist:
      ```
      telegra.ph, binance.com, t.me, coinsniper.net, coinvote.cc, coinmarketcap.com,
      1888pressrelease.com, bitcointalk.org, x.com, twitter.com, reddit.com, wurk.fun,
      content-machine-api-production-509a.up.railway.app
      ```
    - No whitespace, control characters, `<`, `>`, `"` or backticks anywhere in the string.

    Drop any URL that fails. Never "fix up" a URL. Log the event ID, never the full body.
11. **Respond fast.** Once the event is stored in your inbox table, return `200` immediately. Send the
    Telegram DMs from a background job, never inside the request, so our 8-second timeout never fires
    because Telegram is slow.

Additional hardening:
- Rate-limit the endpoint, e.g. 60 requests/min per source IP. Failed-signature requests count double.
- Never follow, fetch, preview or unfurl any URL from an event server-side. They are only text for
  users.
- The receiver must not be able to trigger anything else: no payments, no trending changes, no admin
  actions. Its only side effects are inserting inbox rows and queueing DMs.
- Run the receiver with the smallest possible privileges. It needs the callback secret and DB write
  access to its own tables, and nothing else. In particular, **not** wallet keys.
- Support rotating the secret: accept either `CONTENT_MACHINE_CALLBACK_SECRET` or an optional
  `CONTENT_MACHINE_CALLBACK_SECRET_NEXT` while a rotation is in progress.

---

## 3. Delivering links to the buyer's DMs

- When the payment is confirmed, persist `purchase_id → { telegram_user_id, chat_id, token name,
  symbol, created_at }`. That mapping is the **only** way an event reaches a user. Never use a chat ID
  or user ID from an event, because events don't carry any.
- On `order.accepted`, DM something like:
  "✅ Trending confirmed for $MFROG. Your campaign is being built; links will arrive here as they go
  live."
- On `link.published`, DM one message per link:
  `🔗 {label} is live for ${symbol}:` followed by the URL on its own line. Add an inline button
  "Share" that opens `https://t.me/share/url?url=<url-encoded link>`.
- On `sticker_pack.ready`, DM: "🎨 Your ${symbol} sticker pack is ready. Tap to add it:" followed by
  the `t.me/addstickers` URL on its own line, plus the same "Share" button.
  - The pack is created and held by our sticker bot and team account. That's why the name ends in
    `_by_Fullsendtrenchesbot`.
  - Anyone can add or share it from the link. The buyer doesn't need to start, message or own
    anything else.
  - Don't mention who owns or created the pack. It's simply "your sticker pack".
  - If the coin had no logo, no pack is made and this event never comes.
- On `order.completed`, send one summary:
  - A ✅ line per success with its URL.
  - "⚠️ {label}: didn't go through" for each failure. **Don't include error text.**
  - A closing line.
- Also keep a `/campaign` (or button) view that lists every link received so far for the user's
  purchases, read from your stored events, so users can re-share later.
- Send all messages **without `parse_mode`**, as plain text. URLs come from us, but plain text
  guarantees no Markdown/HTML injection. If you need formatting, build it with Telegram `entities`
  rather than by concatenating HTML.
- Dedupe per `(purchase_id, url)` so a user never gets the same link twice as its own DM. The
  `order.completed` summary is the exception: it is one message that lists every link, including ones
  already sent.
- If a DM fails with 403 (the user blocked the bot or never started it), mark the link as
  undelivered. Show it the next time they open the bot. Don't retry in a tight loop, and respect
  Telegram's 429 `retry_after`.
- Never tell users, anywhere, that content was AI-generated or automated. Describe it as "your
  campaign" or "your coverage".

---

## 4. Tests to include

Test the receiver with these cases:
- A valid signed event is accepted and DMs are queued.
- A replayed `X-Event-ID` produces no second DM.
- A bad signature returns 401. A missing or old timestamp (>300s) returns 401.
- An oversized body returns 413. A wrong content type returns 415. A `GET` returns 404.
- An unknown event type returns 204 with no side effects. An unknown `purchase_id` returns 200 with no
  DM.
- The registered URL answers `POST` directly, with no redirect.
- A `link.published` arriving after `order.completed` is still handled once.
- These URLs are all dropped:
  - `http://…`
  - `javascript:…`
  - `https://user:pass@telegra.ph/x`
  - `https://evil.com/telegra.ph`
  - `https://telegra.ph.evil.com/x`
  - A URL with a newline or `<`
- The signature is computed over the raw bytes. Re-serialized JSON must not verify if the bytes
  differ.

Test intake with these cases:
- A retried POST with the same `purchase_id` gets 200 and there's still one order.
- A 400 is not retried; a 503 is retried with backoff; the outbox survives a restart.
- Absent socials are omitted, never sent as empty strings.

Reference signature snippet (Node):

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
function verify(secret, ts, rawBody, sigHex) {
  const expected = createHmac('sha256', secret).update(ts + '.').update(rawBody).digest();
  const given = Buffer.from(sigHex, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

Deliverable: the outbox sender, the receiver endpoint, the inbox, event-dedupe and link tables, the
DM worker, `/campaign` and tests. Then send us the receiver's full HTTPS URL so we can register it.
