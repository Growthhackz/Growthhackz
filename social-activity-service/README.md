# Social Activity Service

Backend service that places social activity orders with an SMM panel provider (Followiz), then tracks them until they finish.

It stores each order's metadata, checks targets and quantities against the provider's service catalog, submits orders safely (never twice), polls for progress, reconciles spend against what the provider actually charged, and handles refills and cancels.

**Products:** Twitter/X followers, likes, retweets and custom comments; website traffic; Telegram members (with an optional premium variant). Each can be targeted by geo (`any`, `north_america`, `usa`, `canada`).

**Order types:** `default`, `drip_feed`, `custom_comments`, `subscription` (auto likes/RTs on future posts).

## Run it

```bash
npm install
cp .env.example .env      # PROVIDER=mock by default: no key, no spend
npm run dev               # or: npm run build && npm start
npm test
```

Requires Node ≥ 22.5 (uses the built-in `node:sqlite`).

### Going live with Followiz

**Quick path.** With `FOLLOWIZ_API_KEY` set, run:

```bash
PROVIDER=followiz npm run setup:provider                  # balance, catalog sync, top 5 services per package item
PROVIDER=followiz npm run setup:provider -- --apply       # also map each item to its top pick
cp package-request.example.json my-request.json            # fill in your targets and comments
PROVIDER=followiz npm run setup:provider -- --preview my-request.json
```

The script never places orders. Services are ranked by keyword matching on their names:

- **Preferred:** the right platform and product, the package's region, a minimum that fits the package range, drip-feed, and refill for followers and members.
- **Penalised:** services labelled bots or cheap.

Review the list before `--apply`. `--overwrite` replaces existing mappings. The same data is available from `GET /v1/catalog/recommendations` and `POST /v1/catalog/recommendations/apply`.

**Manual path:**

1. Set `PROVIDER=followiz`, `FOLLOWIZ_API_KEY=...` and a `SERVICE_API_TOKEN`.
2. `POST /v1/catalog/sync` pulls the current service list (it also syncs every 6 h).
3. Find the services you want with `GET /v1/catalog/services?q=telegram`, then map each product to one:

   ```bash
   curl -X PUT localhost:4010/v1/catalog/mappings -H "authorization: Bearer $TOKEN" \
     -H 'content-type: application/json' \
     -d '{"product":"telegram_members","geo":"north_america","premium":true,"serviceId":"1234"}'
   ```

   A single order can also skip the mapping by passing `serviceId`.
4. Fund the Followiz account on their site, and optionally record it with `POST /v1/ledger/funding`.

## Placing orders

```bash
curl -X POST localhost:4010/v1/campaigns \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'idempotency-key: launch-2026-09-24-01' \
  -d '{
    "name": "Launch test",
    "budgetUsd": 50,
    "targeting": { "geo": "north_america" },
    "autoRefill": true,
    "metadata": { "experiment": "launch-a" },
    "orders": [
      { "product": "twitter_followers", "link": "https://x.com/yourhandle", "quantity": 1000 },
      { "product": "twitter_likes", "geo": "any", "link": "https://x.com/yourhandle/status/123", "quantity": 200 },
      { "product": "twitter_retweets", "geo": "any", "type": "drip_feed", "link": "https://x.com/yourhandle/status/123", "quantity": 20, "runs": 5, "intervalMinutes": 60 },
      { "product": "twitter_comments", "link": "https://x.com/yourhandle/status/123", "comments": ["Great thread", "Saving this"] },
      { "product": "website_traffic", "link": "https://example.com/landing", "quantity": 5000 },
      { "product": "telegram_members", "link": "https://t.me/yourchannel", "quantity": 500, "premium": true }
    ]
  }'
```

- The request is rejected (400/409) before anything is sent if a link is malformed, a quantity is outside the service's min/max, no service is mapped, the estimate exceeds `budgetUsd`, or the same target already has an active order on that service.
- Before submitting, the service checks that the provider balance covers the whole batch. If it doesn't, you get a `402` and the orders stay as `draft`. Retry later with `POST /v1/campaigns/:id/submit`.
- `"submit": false` creates drafts only.
- Sending the same `Idempotency-Key` again returns the original campaign (`200`, `idempotent-replayed: true`) instead of ordering twice.
- Website links get `utm_source`, `utm_medium` and `utm_campaign` added (unless already set, or `"utm": false`), so this traffic can be separated in analytics.

## Packages (default orders)

`starter` is a small, test-sized package. Deliveries are spread out so nothing arrives as one spike:

| Item | Default | Range | Delivery |
|---|---|---|---|
| `telegram_members` | 10 | 5–10 | one delivery |
| `telegram_premium` (opt-in) | 2 | 1–2 | one delivery |
| `twitter_followers` | 50 | 25–50 | drip: 5 runs, one per day |
| `twitter_likes` | 50 | 25–50 | drip: 5 runs, one per hour |
| `twitter_retweets` | 25 | 25–50 | drip: 5 runs, every 90 min |
| `twitter_comments` | your comment texts | 5–25 | one delivery (only if `comments` are sent) |
| `website_traffic` | 1500 | 1000–2000 | drip: 3 runs, one per day |

All items prefer `north_america` services. If no North America service is mapped for an item, it falls back to the `any` mapping and says so in the notes.

**Fitting to the catalog:** the package adjusts to each service's limits and records every change in `notes`:

- A quantity below the service minimum is raised to the minimum if that is still inside the item's range. If the minimum is above the range, the item is **skipped**, unless you pass `allowAboveRange: true`.
- Drip-feed is reduced to fewer runs, or dropped to a single delivery, when each run would fall under the service minimum or the service has no drip-feed.

Tiny Telegram orders (5–10 members, 1–2 premium) are below many panels' minimums, so check the preview.

Always preview first:

```bash
curl -X POST localhost:4010/v1/packages/starter/preview -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{
    "targets": {
      "twitterProfile": "@yourhandle",
      "tweet": "https://x.com/yourhandle/status/123",
      "telegram": "https://t.me/yourchannel",
      "website": "https://example.com/landing"
    },
    "comments": ["Great thread", "Saving this", "Agree with point 2", "Useful breakdown", "Following for more"],
    "include": ["telegram_premium"]
  }'
```

Then send the same body to `POST /v1/packages/starter/order`. It also accepts `name`, `budgetUsd`, `autoRefill`, `metadata`, `submit` and an `Idempotency-Key` header. Other options:

- `exclude: ["website_traffic"]` drops items.
- `quantities: {"twitter_likes": 30}` overrides a default.
- `geo` changes the preferred geo for all items.

Items with no target are skipped. You must pass the tweet URL yourself: the service doesn't call the X API, so it can't look up your pinned or top tweet.

## Order lifecycle

```
draft ──submit──▶ submitting ──▶ pending ──▶ in_progress/processing ──▶ completed | partial | canceled
                      │
                      ├── provider returned {"error"} ──▶ failed        (nothing created, no spend)
                      └── timeout / 5xx / bad body    ──▶ needs_review  (may exist on the panel)
```

**Why `needs_review` exists:** Followiz's `add` call has no duplicate protection. If it times out, the order may or may not exist on the panel, so the service **never retries automatically**. Check the Followiz dashboard, then call:

- `POST /v1/orders/:id/resolve {"resolution":"exists","providerOrderId":"12345"}` to link it and resume tracking, or
- `POST /v1/orders/:id/resolve {"resolution":"not_created"}` to return it to `draft` so it can be resubmitted.

Orders left in `submitting` by a crash are moved to `needs_review` on startup.

**Polling:** Followiz has no webhooks. A worker batches up to 100 ids per `status` call. Each order is re-checked after 2 min; the wait doubles up to 30 min while nothing changes and resets when progress moves. Orders still `pending` after `STUCK_PENDING_HOURS` get a `stuck` flag and event.

**Spend:** at submit, the ledger records the estimate. Every poll adds an adjustment so the recorded spend equals the provider's latest `charge`, which covers partial refunds and cancels.

**Refills:** the refill guarantee is parsed from the service name (`[R30]`, `30 Days Refill`, ...) and runs from completion. `POST /v1/orders/:id/refill` triggers one manually. Orders with `autoRefill` get one every `AUTO_REFILL_EVERY_DAYS` while the window is open, and refill status is polled.

## API

All `/v1` routes need `Authorization: Bearer $SERVICE_API_TOKEN`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness + order counts (no auth) |
| GET | `/v1/products` | Products, order types, geos |
| GET | `/v1/catalog/services?q=&includeInactive=` | Synced provider services |
| POST | `/v1/catalog/sync` | Re-pull the service list now |
| GET | `/v1/catalog/recommendations?package=` | Ranked services per package item |
| POST | `/v1/catalog/recommendations/apply` | Map each item to its top pick |
| GET / PUT / DELETE | `/v1/catalog/mappings` | Product + geo + premium → service id |
| GET | `/v1/balance` | Provider balance, low-balance flag, ledger totals |
| GET | `/v1/ledger` | Recent ledger entries |
| POST | `/v1/ledger/funding` | Record a manual top-up |
| GET | `/v1/packages` | Package definitions |
| POST | `/v1/packages/:name/preview` | What a package would order right now, with cost and adjustments |
| POST | `/v1/packages/:name/order` | Order a package as a campaign |
| POST | `/v1/campaigns` | Create (and by default submit) a campaign |
| GET | `/v1/campaigns`, `/v1/campaigns/:id` | Campaigns with orders, estimate and spend |
| POST | `/v1/campaigns/:id/submit` | Submit remaining drafts |
| POST | `/v1/campaigns/:id/refresh` | Poll the campaign's active orders now |
| GET | `/v1/orders?status=` | List orders (e.g. `status=needs_review`) |
| GET | `/v1/orders/:id` | Order with event history and refills |
| POST | `/v1/orders/:id/submit` \| `refresh` \| `cancel` \| `refill` \| `resolve` | Order actions |
| GET | `/v1/provider-calls?action=` | Raw provider request/response log (API key never stored) |

## Layout

```
src/
  providers/        SocialProvider interface; followiz/ (HTTP client, mapper, adapter); mock/
  domain/           products, link normalization, request schemas
  db/               node:sqlite, migrations, repositories
  services/         catalog, orders, polling, refills, balance
  workers/          background scheduler
  routes/           HTTP API
```

To add another panel, implement `SocialProvider` and register it in `providers/registry.ts`. Most panels use the same Perfect Panel v2 API, so `FollowizClient` usually works with just a different URL.

The storage layer is SQLite through `db/repositories.ts`. Moving to Postgres only means replacing that file and `db/database.ts`.

## Not verified independently

`start_count`, `remains` and geo/premium targeting are whatever the provider reports. If you need proof of delivery, check follower and member counts yourself (X API, Telegram Bot API `getChatMemberCount`) and use your own analytics for traffic.
