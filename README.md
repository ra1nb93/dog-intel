# 🐕 DOG•GO•TO•THE•MOON Intelligence Dashboard

> Real-time intelligence + paper trading agent for the $DOG Army — powered by **Kraken CLI**

![Dashboard Preview](screenshot.png)

🌐 **Live:** https://dog-intel.onrender.com

---

## What is this?

A live intelligence and paper trading dashboard for the **DOG•GO•TO•THE•MOON** Runes token that combines:

- 📈 Real-time price, volume, VWAP, 24h range
- 🧠 **Pack Index** — proprietary 0-100 composite score
- 📊 **Candlestick chart** — 15m/1h/4h with Bollinger Bands, EMA overlay, RSI panel, volume bars, whale markers and crosshair tooltip
- 📐 **RSI(14)** and **EMA(9/21) crossover** — calculated on real OHLC candles
- 🐋 Whale trade detection with **volume-weighted** scoring (≥ 500K DOG) — markers on chart
- ⚡ **Volume Impulse** — volume vs SMA10, brighter bars when above average
- 🧱 Order book wall detection (≥ 5M DOG)
- 🤖 **Agent Decision** — WATCH_BUY / HOLD / WATCH_SELL / RISK_OFF
- 📄 **Paper Trading** — simulate entries and exits, track P&L (local only)
- 🔑 **Live Portfolio Viewer** — connect your Kraken account to monitor your real DOG position
- ₿ **BTC Network Context** — BTC price, mempool fees, recent blocks via mempool.space
- 🔔 **Telegram Alerts** — notifications on WATCH_BUY, WATCH_SELL, RSI overbought/oversold
- ↓ **Export** — download report as JSON or CSV
- ☀️ **Dark/Light mode** — toggle in header

All market data is pulled directly from Kraken via the official **[Kraken CLI](https://www.kraken.com/kraken-cli)** — no third-party market APIs, no middlemen.

---

## Decision Engine

The Pack Index is a deterministic 0-100 score computed from four components:

| Component | Weight | What it measures |
|-----------|--------|-----------------|
| **Liquidity** | 0-25 | Spread + bid depth within 1% |
| **Momentum** | 0-25 | RSI(14) + EMA crossover + VWAP distance |
| **Risk** | 0-25 | Ask walls proximity + volatility |
| **Whale** | 0-25 | Volume-weighted buy vs sell pressure |

### Decisions

| Decision | Trigger | Action |
|----------|---------|--------|
| 🟢 **WATCH_BUY** | Score ≥ 65, RSI < 70 | Strong entry signal |
| 🟡 **HOLD** | Score 36-64 | No strong signal |
| 🔴 **WATCH_SELL** | Score ≤ 35 or RSI > 80 | Exit signal |
| ⛔ **RISK_OFF** | Spread > 1% | Market illiquid, stay out |

No LLM in the decision loop — pure deterministic math on live Kraken data.

---

## Telegram Alerts

The server sends Telegram notifications when:

- 🟢 Decision changes to **WATCH_BUY**
- 🔴 Decision changes to **WATCH_SELL**
- ⛔ **RISK_OFF** triggered (spread anomaly)
- ⚠️ **RSI > 80** (overbought)
- 💎 **RSI < 25** (oversold)

To enable, set environment variables:
```bash
TG_TOKEN=your_bot_token
TG_CHAT_ID=your_chat_id
```

Create a bot via [@BotFather](https://t.me/BotFather) on Telegram.

---

## Stack

| Layer | Tech |
|-------|------|
| Data source | Kraken CLI (`ticker`, `orderbook`, `trades`, `ohlc`, `paper`) |
| BTC context | mempool.space public API |
| Backend | Node.js (zero npm dependencies, native `http` module) |
| Frontend | Vanilla HTML/CSS/JS — no build step |
| Chart | Canvas API — candlesticks, BB, RSI, volume, whale markers |
| Hosting | Render.com (free tier, Docker) |
| Uptime | UptimeRobot ping every 5min |
| Alerts | Telegram Bot API |
| Refresh | Auto every 60s (server cache) + 30s client poll |
| Mobile | Fully responsive, works on any device |

---

## Requirements (local)

- **Node.js** v18+
- **Kraken CLI** installed

### Install Kraken CLI

```bash
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/krakenfx/kraken-cli/releases/latest/download/kraken-cli-installer.sh | sh

source $HOME/.cargo/env
kraken --version
```

---

## Quick Start (local)

```bash
# 1. Clone the repo
git clone https://github.com/ra1nb93/dog-intel.git
cd dog-intel

# 2. Start the server (optional: with Telegram alerts)
TG_TOKEN=your_token TG_CHAT_ID=your_chat_id node server.js

# 3. Open the dashboard
open http://localhost:3001
```

**Mobile on same WiFi network:**
```bash
ipconfig getifaddr en0   # find your local IP
# Open on phone: http://YOUR_LOCAL_IP:3001
```

**Paper trading note:** Paper trading is available locally only. On the live deployment, the dashboard shows intelligence + live portfolio viewer.

---

## CLI Usage

```bash
node dog-intel.js          # terminal report
node dog-intel.js --json   # JSON output
node dog-intel.js --watch  # auto-refresh every 60s
```

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Dashboard HTML |
| `/api/report` | GET | Full intelligence report (JSON, cached 60s) |
| `/api/ohlc?interval=15\|60\|240` | GET | OHLC candles by timeframe |
| `/api/btc` | GET | BTC network context (fees, blocks, price) |
| `/api/paper/status` | GET | Paper account status + P&L |
| `/api/paper/history` | GET | Paper trade history |
| `/api/paper/buy` | POST | Execute paper buy |
| `/api/paper/sell` | POST | Execute paper sell |
| `/api/live/portfolio` | POST | Real Kraken portfolio (read-only) |
| `/api/health` | GET | Server health check |

---

## Deploy (Docker + Render)

```bash
# Render setup:
# 1. Connect GitHub repo
# 2. Language: Docker
# 3. Instance: Free
# 4. Environment variables: TG_TOKEN, TG_CHAT_ID (optional)
# 5. Deploy
```

Auto-deploys on every `git push` to main.

---

## Project Structure

```
dog-intel/
├── README.md           ← you are here
├── Dockerfile          ← Docker deploy (installs Kraken CLI Linux binary)
├── package.json        ← { "type": "module" }
├── server.js           ← API + HTML server (zero dependencies)
├── decision-engine.js  ← Pack Index, RSI, EMA, whale scoring
├── dog-intel.js        ← CLI intelligence report
└── index.html          ← dashboard (served by server.js)
```

---

## Thresholds & Configuration

| Parameter | Value |
|-----------|-------|
| Whale trade threshold | ≥ 500,000 DOG |
| Order wall threshold | ≥ 5,000,000 DOG |
| Volume Impulse period | SMA 10 |
| WATCH_BUY trigger | Pack Index ≥ 65, RSI < 70 |
| WATCH_SELL trigger | Pack Index ≤ 35 or RSI > 80 |
| RISK_OFF trigger | Spread > 1% |
| OHLC intervals | 15m / 1h / 4h |
| RSI period | 14 |
| EMA periods | 9 and 21 |
| Bollinger Bands | 20 period, 2σ |
| Paper trade size | $500 USD |
| Paper starting balance | $10,000 USD |
| Cache TTL | 60s |
| BTC context cache | 2 min |
| Telegram alert cooldown | per decision change |

---

## Privacy

This tool does not collect, store, or transmit any personal data. API credentials are used in-memory only and never stored on disk or logged. Not financial advice.

---

## 🎯 For Kraken Reviewers

### How we use Kraken CLI

Every data point comes exclusively from Kraken CLI:

```bash
kraken ticker DOGUSD -o json        # price, bid, ask, volume, VWAP
kraken orderbook DOGUSD -o json     # order book depth, wall detection
kraken trades DOGUSD -o json        # recent trades, whale detection
kraken ohlc DOGUSD --interval 60    # hourly candles → RSI + EMA + BB
kraken ohlc DOGUSD --interval 15    # 15m candles
kraken ohlc DOGUSD --interval 240   # 4h candles
kraken paper init                   # paper account initialization
kraken paper buy/sell               # paper trade execution
kraken paper status/history/balance # paper portfolio state
```

No third-party market APIs. Kraken CLI is the sole data layer.

### What makes dog-intel different

| Feature | Typical pattern | dog-intel |
|---------|----------------|-----------|
| LLM in decision loop | Yes | ❌ Deterministic Pack Index |
| Data source | REST API | ✅ Kraken CLI exclusively |
| Dashboard | Local only | ✅ Live at dog-intel.onrender.com |
| Mobile support | None | ✅ Fully responsive |
| Candlestick chart | Basic | ✅ BB + RSI + volume + whale markers |
| Multi-timeframe | Single | ✅ 15m / 1h / 4h |
| Whale detection | None | ✅ Volume-weighted, markers on chart |
| Volume Impulse | None | ✅ vs SMA10, visual on bars |
| BTC Network context | None | ✅ mempool.space integration |
| Telegram alerts | None | ✅ WATCH_BUY/SELL, RSI extremes |
| Export | None | ✅ JSON + CSV |
| Dark/Light mode | None | ✅ Toggle in header |
| Deploy | Local only | ✅ Docker + Render, zero config |

### Evaluation criteria

**Innovation & Originality**
Pack Index combines liquidity, RSI momentum, risk-inverted wall detection, and volume-weighted whale scoring into a single deterministic 0-100 signal. Whale markers on the candlestick chart, Volume Impulse indicator, and Telegram alerts add layers not found in other submissions.

**Technical Execution**
Zero npm dependencies in backend — Node.js native `http` module only. Secret passed via `--api-secret-stdin` (never exposed in process listing). Canvas-based chart with Bollinger Bands, RSI panel, volume bars, and whale markers — all computed client-side.

**Kraken CLI Usage**
9 distinct CLI commands. OHLC drives RSI(14), EMA(9/21), Bollinger Bands, Volume Impulse, and whale marker matching. Paper trading auto-initialized on server start.

**Clarity & Presentation**
Live at **https://dog-intel.onrender.com**. No installation required. Works on desktop and mobile.

**Practical Utility**
Built for the $DOG Army. Free, open source. Telegram bot alerts the user when market conditions change — no need to watch the dashboard. JSON/CSV export for further analysis.

### Files to inspect

| File | What it does |
|------|-------------|
| `server.js` | API server — zero dependencies, Telegram alerts, BTC context |
| `decision-engine.js` | Pack Index, RSI, EMA, whale volume scoring |
| `dog-intel.js` | CLI terminal report |
| `index.html` | Dashboard — chart, paper trading, portfolio viewer |
| `Dockerfile` | Docker deploy — installs Kraken CLI Linux binary |

---

## Submission

🐦 [X post #1](https://x.com/Ra1nBlack/status/2058219061142589483)
🐦 [X post #2](https://x.com/Ra1nBlack)

---

## License

MIT — fork it, build on it, go to the moon. 🐕

---

*Built with ❤️ and Kraken CLI · Data refreshes every 60s · Not financial advice*