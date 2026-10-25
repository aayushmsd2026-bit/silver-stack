# Stack: Silver & Gold Tracker

A personal, mobile-first tracker for a silver and gold stack in Nepal. It uses daily rates from the **Federation of Nepal Gold & Silver Dealers' Association (FENEGOSIDA)**.

## What it does
- **Holdings**: log buys and sells by weight (grams or tola) and the total bill. Making charge (default 4%, only for lots under 500 g) and SDF (default 0.5%, every lot) are split out automatically. All three are editable per purchase and in Settings.
- **P&L**: market value, cost basis, unrealised and realised P&L (average-cost method), today's change, break-even rate, metal-only cost, and an "if sold today" value after the dealer buyback cut.
- **Markets**: silver and gold per tola, per 10 g, per gram and per kg. Price history with touch scrubbing and your buys plotted on the chart. 1W/1M/3M/1Y returns, 52-week high and low, volatility, and international spot with the Nepal premium.
- **Gold ÷ Silver ratio**: the Nepal and international ratios, history, a zone gauge, a percentile, and a swap calculator.
- **Insights**: XIRR, total return, stack value vs. invested over time, allocation, total making charge and SDF paid, monthly buying, best and worst lots, a what-if price simulator, goals and milestones.
- **Price alerts**: banners when a rate crosses your buy or sell targets.
- **Sign in with Google**: sync your stack live across your phone and laptop (Firebase). Without signing in, data stays on the device, with optional private GitHub Gist backup and JSON/CSV export.
- Installable PWA (Add to Home Screen) that works offline, with light and dark mode.

## How rates update
`.github/workflows/prices.yml` runs `scripts/fetch_prices.py` on a schedule. Runs are every 20 minutes during FENEGOSIDA's morning publishing window and every 2 hours otherwise. It reads the FENEGOSIDA API, falling back to Hamro Patro and then Ashesh, plus the international spot price and the NRB USD rate. It commits `data/prices.json` and `data/history.json`, and the site reads those files. History grows every day.

To force an update: **Actions → Update prices → Run workflow**.

## Turning on Sign in with Google (one-time, ~5 minutes)
1. Go to <https://console.firebase.google.com> → **Create a project** (any name, e.g. `silver-stack`). You can turn Google Analytics off.
2. **Build → Authentication → Get started → Sign-in method → Google → Enable**, choose your support email, then **Save**.
3. **Authentication → Settings → Authorized domains → Add domain** → `aayushmsd2026-bit.github.io`
4. **Build → Firestore Database → Create database**. Pick a location near Nepal (e.g. `asia-south1`) and start in **production mode**.
5. In Firestore, open the **Rules** tab, replace everything with the contents of [`firestore.rules`](firestore.rules), and **Publish**. This makes sure each Google account can only see its own stack.
6. **Project settings (gear icon) → General → Your apps → Web (`</>`)**. Register the app (no hosting needed) and copy the `firebaseConfig` values into [`js/firebase-config.js`](js/firebase-config.js). Only `apiKey`, `authDomain`, `projectId` and `appId` are needed.
7. Commit the change. In about a minute, **Settings → Account → Sign in with Google** appears in the app.

The Firebase web config is safe to have in a public repo, because access is controlled by the Firestore rules.
