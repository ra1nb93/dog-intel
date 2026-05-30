# 🐕 DOG•GO•TO•THE•MOON Intelligence Dashboard

> Real-time intelligence + paper trading agent for the $DOG Army — powered by **Kraken CLI**

![Dashboard Preview](screenshot.png)

---

## What is this?

A live intelligence and paper trading dashboard for the **DOG•GO•TO•THE•MOON** Runes token that combines:

- 📈 Real-time price, volume, VWAP, 24h range
- 🧠 **Pack Index** — proprietary 0-100 composite score
- 📊 **RSI(14)** and **EMA(9/21) crossover** — calculated on real hourly candles
- 🐋 Whale trade detection with **volume-weighted** scoring (≥ 500K DOG)
- 🧱 Order book wall detection (≥ 5M DOG)
- ⚡ Buy/sell pressure analysis (last 100 trades)
- 🤖 **Agent Decision** — WATCH_BUY / HOLD / WATCH_SELL / RISK_OFF
- 📄 **Paper Trading** — simulate entries and exits, track P&L
- 🔑 **Live Portfolio Viewer** — connect your Kraken account to monitor your real DOG position

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
| 🟢 **WATCH_BUY** | Score ≥ 65, RSI < 70, no DOG held | Paper Buy enabled |
| 🟡 **HOLD** | Score 36-64, no strong signal | Maintain position |
| 🔴 **WATCH_SELL** | Score ≤ 35 or RSI > 80, DOG held | Paper Sell enabled |
| ⛔ **RISK_OFF** | Spread > 1% | Stay out |

No LLM in the decision loop — pure deterministic math on live Kraken data.

---

## Stack

| Layer | Tech |
|-------|------|
| Data source | Kraken CLI (`ticker`, `orderbook`, `trades`, `ohlc`) |
| Backend | Node.js (zero npm dependencies, native `http` module) |
| Frontend | Vanilla HTML/CSS/JS — no build step |
| Refresh | Auto every 60s (server cache) + 30s client poll |
| Mobile | Responsive CSS, accessible on any device on same network |

---

## Requirements

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

## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/ra1nb93/dog-intel.git
cd dog-intel

# 2. Initialize paper trading account
kraken paper init

# 3. Start the server
node server.js

# 4. Open the dashboard
# Desktop:
open http://localhost:3001

# Mobile (same WiFi network):
# open http://YOUR_LOCAL_IP:3001
```

Find your local IP:
```bash
ipconfig getifaddr en0   # macOS
hostname -I              # Linux
```

---

## CLI Usage

Run the intelligence report directly in your terminal:

```bash
# Human-readable report
node dog-intel.js

# JSON output (for scripting / integrations)
node dog-intel.js --json

# Auto-refresh every 60 seconds
node dog-intel.js --watch
```

### Example terminal output

```
────────────────────────────────────────────────────────────
🐕  DOG•GO•TO•THE•MOON — Intelligence Report
30/05/2026, 22:11:42
────────────────────────────────────────────────────────────

PRICE
  Last     $0.000693  ▲ 12.75% 24h
  Bid/Ask  $0.000690 / $0.000693
  24h      H: $0.000711  L: $0.000610
  VWAP 24h $0.000654

PACK INDEX  60/100  trend →
  Liquidity 23  Momentum 11  Risk 16  Whale 10
  RSI(14)  72 [OVERBOUGHT]
  EMA Cross  GOLDEN (EMA9 > EMA21)

SIGNALS
  🧱  Ask wall 6.77M DOG @ $0.000717
  🛡️   Bid wall 13.06M DOG @ $0.000680
  🐋  Market BUY: 587.0K DOG ($415.58)
  📈  Price 5.56% above 24h VWAP

DECISION: HOLD
  Pack Index 60/100 · RSI 71.97 · trend →
  → Hold position
```

---

## API Endpoints

With `server.js` running:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Dashboard HTML |
| `/api/report` | GET | Full intelligence report (JSON, cached 60s) |
| `/api/paper/status` | GET | Paper account status + P&L |
| `/api/paper/history` | GET | Paper trade history |
| `/api/paper/buy` | POST | Execute paper buy ($500 default) |
| `/api/paper/sell` | POST | Execute paper sell (all DOG) |
| `/api/live/portfolio` | POST | Real Kraken portfolio (read-only, requires API key) |
| `/api/health` | GET | Server health check |

### Live Portfolio (read-only)

```bash
curl -X POST http://localhost:3001/api/live/portfolio \
  -H "Content-Type: application/json" \
  -d '{"apiKey":"YOUR_KEY","apiSecret":"YOUR_SECRET"}'
```

Returns: DOG balance, trade history, open orders, avg buy price, unrealized P&L.

**Required API permissions:** Query Funds only. No trading permissions needed.

---

## Project Structure

```
dog-intel/
├── README.md           ← you are here
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
| Cache TTL | 60s |

---

## Built for the Kraken CLI Agent Zero Competition

This project was built as a submission for the **[Kraken CLI Agent Zero Promotion](https://support.kraken.com/articles/agent-zero-promotion)** — a $25,000 competition for the best builds using Kraken CLI.

The goal: give the **$DOG Army** a free, open-source intelligence and paper trading tool that:
- Runs locally with zero cloud dependencies
- Uses Kraken CLI as the sole data source
- Provides a deterministic decision engine (no LLM in the trading loop)
- Works on desktop and mobile

---

## Submission

🐦 [X post](https://x.com/Ra1nBlack/status/2058219061142589483)

---

## License

MIT — fork it, build on it, go to the moon. 🐕

---

*Built with ❤️ and Kraken CLI · Data refreshes every 60s · Not financial advice*