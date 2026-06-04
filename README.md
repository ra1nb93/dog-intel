# 🐕 DOG•GO•TO•THE•MOON Intelligence Dashboard

> Real-time intelligence + paper trading agent for the $DOG Army — powered by **Kraken CLI**

![Dashboard Preview](screenshot.png)

🌐 **Live:** https://dog-intel.onrender.com

---

## What is this?

A live intelligence and paper trading dashboard for the **DOG•GO•TO•THE•MOON** Runes token that combines:

- 📈 Real-time price, volume, VWAP, 24h range
- 🧠 **Pack Index** — proprietary 0-100 composite score
- 📊 **RSI(14)** and **EMA(9/21) crossover** — calculated on real hourly OHLC candles
- 🐋 Whale trade detection with **volume-weighted** scoring (≥ 500K DOG)
- 🧱 Order book wall detection (≥ 5M DOG)
- ⚡ Buy/sell pressure analysis (last 100 trades)
- 🤖 **Agent Decision** — WATCH_BUY / HOLD / WATCH_SELL / RISK_OFF
- 📄 **Paper Trading** — simulate entries and exits, track P&L with $10,000 virtual balance
- 🔑 **Live Portfolio Viewer** — connect your Kraken account to monitor your real DOG position, trade history, open orders and unrealized P&L

All market data is pulled directly from Kraken via the official **[Kraken CLI](https://www.kraken.com/kraken-cli)** — no third-party APIs, no middlemen.

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

Paper BUY and SELL buttons are always enabled — the agent decision is a suggestion, not a blocker.

---

## Stack

| Layer | Tech |
|-------|------|
| Data source | Kraken CLI (`ticker`, `orderbook`, `trades`, `ohlc`) |
| Backend | Node.js (zero npm dependencies, native `http` module) |
| Frontend | Vanilla HTML/CSS/JS — no build step |
| Hosting | Render.com (free tier, Docker) |
| Uptime | UptimeRobot ping every 5min |
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

# 2. Start the server
node server.js

# 3. Open the dashboard
open http://localhost:3001
```

**Mobile on same WiFi network:**
```bash
# Find your local IP
ipconfig getifaddr en0   # macOS

# Open on phone
http://YOUR_LOCAL_IP:3001
```

---

## CLI Usage

```bash
# Human-readable report
node dog-intel.js

# JSON output
node dog-intel.js --json

# Auto-refresh every 60 seconds
node dog-intel.js --watch
```

### Example output

```
────────────────────────────────────────────────────────────
🐕  DOG•GO•TO•THE•MOON — Intelligence Report
31/05/2026, 23:01:22
────────────────────────────────────────────────────────────

PRICE
  Last     $0.000667  ▼ 1.19% 24h
  Bid/Ask  $0.000667 / $0.000670
  24h      H: $0.000715  L: $0.000657
  VWAP 24h $0.000686

PACK INDEX  51/100  trend →
  Liquidity 19  Momentum 7  Risk 13  Whale 12
  RSI(14)  51.38
  EMA Cross  DEATH (EMA9 < EMA21)

DECISION: HOLD
  Pack Index 51/100 · RSI 51.38
  → Wait for entry signal
```

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Dashboard HTML |
| `/api/report` | GET | Full intelligence report (JSON, cached 60s) |
| `/api/paper/status` | GET | Paper account status + P&L |
| `/api/paper/history` | GET | Paper trade history |
| `/api/paper/buy` | POST | Execute paper buy ($500 default) |
| `/api/paper/sell` | POST | Execute paper sell |
| `/api/live/portfolio` | POST | Real Kraken portfolio (read-only) |
| `/api/health` | GET | Server health check |

### Live Portfolio

```bash
curl -X POST https://dog-intel.onrender.com/api/live/portfolio \
  -H "Content-Type: application/json" \
  -d '{"apiKey":"YOUR_KEY","apiSecret":"YOUR_SECRET"}'
```

Returns: DOG balance, trade history, open orders, avg buy price, unrealized P&L.

**Required API permissions:** Query Funds only. No trading permissions needed.

---

## Deploy (Docker + Render)

The repo includes a `Dockerfile` that installs Node.js + Kraken CLI Linux binary.

```bash
# Deploy on Render:
# 1. Connect GitHub repo
# 2. Language: Docker
# 3. Instance: Free
# 4. Deploy
```

Auto-deploys on every `git push` to main.

---

## Project Structure

```
dog-intel/
├── README.md           ← you are here
├── Dockerfile          ← Docker deploy config
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
| WATCH_BUY trigger | Pack Index ≥ 65, RSI < 70 |
| WATCH_SELL trigger | Pack Index ≤ 35 or RSI > 80 |
| RISK_OFF trigger | Spread > 1% |
| OHLC candles | 48h hourly (1h interval) |
| RSI period | 14 |
| EMA periods | 9 and 21 |
| Paper trade size | $500 USD |
| Paper starting balance | $10,000 USD |
| Cache TTL | 60s |
| Server port | 3001 |

---

## Privacy

This tool does not collect, store, or transmit any personal data. API credentials are used in-memory only and never stored on disk or logged. Not financial advice.

---

## Built for the Kraken CLI Agent Zero Competition

This project was built as a submission for the **[Kraken CLI Agent Zero Promotion](https://support.kraken.com/articles/agent-zero-promotion)** — a $25,000 competition for the best builds using Kraken CLI.

The goal: give the **$DOG Army** a free, open-source intelligence and paper trading tool that:
- Runs locally or online with zero cloud dependencies beyond Kraken CLI
- Uses Kraken CLI as the sole data source
- Provides a deterministic decision engine (no LLM in the trading loop)
- Works on desktop and mobile
- Is fully open source and deployable by anyone

---


---

## 🎯 For Kraken Reviewers

This section addresses what the Kraken Agent Zero jury evaluates.

### How we use Kraken CLI

Every data point in the dashboard comes exclusively from Kraken CLI:

```bash
kraken ticker DOGUSD -o json        # price, bid, ask, volume, VWAP
kraken orderbook DOGUSD -o json     # order book depth, wall detection
kraken trades DOGUSD -o json        # recent trades, whale detection
kraken ohlc DOGUSD --interval 60    # hourly candles for RSI + EMA
kraken paper init                   # paper account initialization
kraken paper buy/sell               # paper trade execution
kraken paper status/history/balance # paper portfolio state
```

No third-party market APIs. No external data sources. Kraken CLI is the sole data layer.

### What makes dog-intel different

| Feature | Typical pattern | dog-intel |
|---------|----------------|-----------|
| LLM in decision loop | Yes | ❌ Deterministic Pack Index |
| Data source | REST API / websocket | ✅ Kraken CLI exclusively |
| Dashboard | Local only | ✅ Live at dog-intel.onrender.com |
| Mobile support | None | ✅ Fully responsive |
| Candlestick chart | Rarely | ✅ 48h OHLC with EMA overlay |
| RSI(14) + EMA crossover | Basic | ✅ From real hourly candles |
| Whale detection | None | ✅ Volume-weighted ≥ 500K DOG |
| Portfolio viewer | None | ✅ Real Kraken account integration |
| Deploy | Local only | ✅ Docker + Render, zero config |

### Evaluation criteria — our case

**Innovation & Originality**
The Pack Index combines liquidity, RSI-based momentum, risk-inverted wall detection, and volume-weighted whale scoring into a single deterministic 0-100 signal. No LLM in the decision loop — pure math on live Kraken data.

**Technical Execution**
Zero npm dependencies in the backend — Node.js native `http` module only. Kraken CLI called via `execSync` with `--api-secret-stdin` for security. Docker deploy with automatic Kraken CLI Linux binary installation.

**Kraken CLI Usage**
8 distinct CLI commands used across 3 endpoints. OHLC data drives RSI(14) and EMA(9/21) calculation. Paper trading auto-initialized on server start.

**Clarity & Presentation**
Live at **https://dog-intel.onrender.com** — open in any browser, no installation required. Mobile responsive. Works on iPhone on the same WiFi network via local IP.

**Practical Utility**
Built for the $DOG Army: the community that lives on Kraken. Free, open source, runs locally or online with zero cloud dependencies beyond Kraken CLI. Real user feedback drove the feature set.

### Files to inspect

| File | What it does |
|------|-------------|
| `server.js` | API server — zero dependencies, serves HTML + data |
| `decision-engine.js` | Pack Index, RSI, EMA, whale scoring |
| `dog-intel.js` | CLI intelligence report (terminal mode) |
| `index.html` | Dashboard — candlestick chart, paper trading, portfolio viewer |
| `Dockerfile` | Docker deploy — installs Kraken CLI Linux binary |

## Submission

🐦 [X post](https://x.com/Ra1nBlack/status/2062637112088776836)

---

## License

MIT — fork it, build on it, go to the moon. 🐕

---

*Built with ❤️ and Kraken CLI · Data refreshes every 60s · Not financial advice*
