# Peak Ridge (mockup)

A multichart wall for Peak's top 10 trending coins (Solana, Robinhood, Arc).
Not deployed anywhere.

## Run it with live data

```bash
node mockups/peak-multichart/server.mjs      # Node 18+, no npm install
# open http://localhost:8787
```

Opened without the server (as a file, or as the published preview), the page
falls back to simulated coins and says so in the header.

## Where the data comes from (all free, no keys)

| What | Source | Refresh |
| --- | --- | --- |
| Top 10 board | `peakbuybot.com/api/discovery?chain=all` (mirrors t.me/PeakTrending) | 20s cache, page polls every 5s |
| Price, 5m/1h/24h change, mcap, liquidity, volume, 5m buys/sells, pool address | DexScreener `tokens/v1/{chain}/{mints}` | 4s cache |
| Candle history (1m; 5m/15m built in the page) | GeckoTerminal `pools/{pool}/ohlcv/minute` | 75s cache, max 12 calls/min |
| Charts | TradingView Lightweight Charts 4.2.3 | |

The server exists because peakbuybot.com sends no CORS headers and
GeckoTerminal's free limit is shared per IP, so both get cached in one place.
Coins with no DEX pool yet (e.g. fresh launches on Peak) show "No trading pair yet".
