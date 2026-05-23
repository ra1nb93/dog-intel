/**
 * DOG•GO•TO•THE•MOON — Intelligence API Server
 * 
 * Endpoints:
 *   GET /api/report   → full intelligence report (cached 60s)
 *   GET /api/health   → server status
 * 
 * Usage:
 *   node server.js
 *   node server.js --port 4000
 */

import { execSync } from "child_process";
import http from "http";
import { URL } from "url";

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const PORT       = process.argv.includes("--port")
  ? parseInt(process.argv[process.argv.indexOf("--port") + 1])
  : 3001;
const PAIR       = "DOG/USD";
const WHALE_MIN  = 500_000;
const WALL_MIN   = 5_000_000;
const CACHE_TTL  = 60_000; // ms — refresh data every 60s

// ─── CACHE ───────────────────────────────────────────────────────────────────

let cache = { data: null, ts: 0 };

// ─── KRAKEN CLI HELPERS ───────────────────────────────────────────────────────

function cli(cmd) {
  try {
    const out = execSync(`kraken ${cmd} -o json`, { encoding: "utf8", timeout: 10_000 });
    return JSON.parse(out);
  } catch (e) {
    console.error(`[CLI ERROR] kraken ${cmd}:`, e.message);
    return null;
  }
}

function fmt(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

function pct(a, b) { return parseFloat((((a - b) / b) * 100).toFixed(2)); }

// ─── DATA FETCHERS ────────────────────────────────────────────────────────────

function fetchTicker() {
  const d = cli(`ticker ${PAIR}`);
  if (!d) return null;
  const t = d[PAIR];
  return {
    ask:       parseFloat(t.a[0]),
    bid:       parseFloat(t.b[0]),
    last:      parseFloat(t.c[0]),
    high24h:   parseFloat(t.h[1]),
    low24h:    parseFloat(t.l[1]),
    open:      parseFloat(t.o),
    vwap24h:   parseFloat(t.p[1]),
    volume24h: parseFloat(t.v[1]),
    trades24h: t.t[1],
  };
}

function fetchOrderbook() {
  const d = cli(`orderbook ${PAIR}`);
  if (!d) return null;
  const book = d[PAIR];
  const asks = book.asks.map(([p, s, ts]) => ({ price: parseFloat(p), size: parseFloat(s), ts }));
  const bids = book.bids.map(([p, s, ts]) => ({ price: parseFloat(p), size: parseFloat(s), ts }));
  const askWalls = asks.filter(a => a.size >= WALL_MIN);
  const bidWalls = bids.filter(b => b.size >= WALL_MIN);
  const spread    = asks[0].price - bids[0].price;
  const spreadPct = parseFloat(((spread / asks[0].price) * 100).toFixed(4));
  const mid   = (asks[0].price + bids[0].price) / 2;
  const range = mid * 0.01;
  const bidLiq = bids.filter(b => b.price >= mid - range).reduce((s, b) => s + b.size, 0);
  const askLiq = asks.filter(a => a.price <= mid + range).reduce((s, a) => s + a.size, 0);
  return { asks: asks.slice(0, 15), bids: bids.slice(0, 15), askWalls, bidWalls, spread, spreadPct, bidLiq, askLiq, mid };
}

function fetchTrades() {
  const d = cli(`trades ${PAIR}`);
  if (!d) return null;
  const trades = d[PAIR].map(([price, volume, time, side, type, , id]) => ({
    price:  parseFloat(price),
    volume: parseFloat(volume),
    time:   parseFloat(time),
    side:   side === "b" ? "BUY" : "SELL",
    type:   type === "m" ? "MARKET" : "LIMIT",
    id:     parseInt(id),
    usdVal: parseFloat(price) * parseFloat(volume),
  }));
  const whaleTrades  = trades.filter(t => t.volume >= WHALE_MIN).sort((a, b) => b.volume - a.volume);
  const recent       = trades.slice(-100);
  const buyVol       = recent.filter(t => t.side === "BUY").reduce((s, t)  => s + t.volume, 0);
  const sellVol      = recent.filter(t => t.side === "SELL").reduce((s, t) => s + t.volume, 0);
  const pressure     = buyVol / (buyVol + sellVol);
  const largest      = [...trades].sort((a, b) => b.volume - a.volume)[0];
  const marketWhales = trades.filter(t => t.type === "MARKET" && t.volume >= WHALE_MIN);
  return { trades: trades.slice(-50), whaleTrades, buyVol, sellVol, pressure, largest, marketWhales };
}

// ─── SIGNALS ─────────────────────────────────────────────────────────────────

function analyze(ticker, book, trades) {
  const signals = [];
  if (trades.pressure > 0.65)
    signals.push({ type: "BULLISH",    msg: `Buy pressure ${(trades.pressure * 100).toFixed(0)}% in recent trades` });
  else if (trades.pressure < 0.35)
    signals.push({ type: "BEARISH",    msg: `Sell pressure ${((1 - trades.pressure) * 100).toFixed(0)}% in recent trades` });
  if (book.askWalls.length) {
    const top = [...book.askWalls].sort((a, b) => b.size - a.size)[0];
    signals.push({ type: "WALL",       msg: `Ask wall ${fmt(top.size)} DOG @ $${top.price.toFixed(6)}` });
  }
  if (book.bidWalls.length) {
    const top = [...book.bidWalls].sort((a, b) => b.size - a.size)[0];
    signals.push({ type: "SUPPORT",    msg: `Bid wall ${fmt(top.size)} DOG @ $${top.price.toFixed(6)}` });
  }
  if (trades.marketWhales.length) {
    const last = trades.marketWhales.at(-1);
    signals.push({ type: last.side === "BUY" ? "WHALE_BUY" : "WHALE_SELL",
      msg: `Market ${last.side}: ${fmt(last.volume)} DOG ($${last.usdVal.toFixed(2)})` });
  }
  if (ticker.last > ticker.vwap24h * 1.005)
    signals.push({ type: "ABOVE_VWAP", msg: `Price ${pct(ticker.last, ticker.vwap24h)}% above 24h VWAP` });
  else if (ticker.last < ticker.vwap24h * 0.995)
    signals.push({ type: "BELOW_VWAP", msg: `Price ${pct(ticker.last, ticker.vwap24h)}% below 24h VWAP` });
  return signals;
}

// ─── REPORT BUILDER ──────────────────────────────────────────────────────────

function buildReport() {
  console.log("[fetch] pulling fresh data from Kraken CLI...");
  const ticker = fetchTicker();
  const book   = fetchOrderbook();
  const trades = fetchTrades();
  if (!ticker || !book || !trades) return null;
  const signals   = analyze(ticker, book, trades);
  const change24h = pct(ticker.last, ticker.open);
  return {
    timestamp: new Date().toISOString(),
    price: {
      last:      ticker.last,
      ask:       ticker.ask,
      bid:       ticker.bid,
      high24h:   ticker.high24h,
      low24h:    ticker.low24h,
      change24h,
      vwap24h:   ticker.vwap24h,
    },
    volume: {
      total24h:  ticker.volume24h,
      trades24h: ticker.trades24h,
      usd24h:    ticker.volume24h * ticker.vwap24h,
    },
    orderbook: {
      spread:     book.spread,
      spreadPct:  book.spreadPct,
      bidLiq1pct: book.bidLiq,
      askLiq1pct: book.askLiq,
      asks:       book.asks,
      bids:       book.bids,
      bidWalls:   book.bidWalls,
      askWalls:   book.askWalls,
    },
    whales: {
      trades:       trades.whaleTrades.slice(0, 10),
      marketWhales: trades.marketWhales.slice(-5),
      buyPressure:  parseFloat((trades.pressure * 100).toFixed(1)),
      largestTrade: trades.largest,
      recent:       trades.trades.slice(-20).reverse(),
    },
    signals,
  };
}

// ─── CACHE LAYER ─────────────────────────────────────────────────────────────

function getCachedReport() {
  const now = Date.now();
  if (cache.data && now - cache.ts < CACHE_TTL) {
    console.log(`[cache] serving cached data (${Math.round((now - cache.ts) / 1000)}s old)`);
    return cache.data;
  }
  const report = buildReport();
  if (report) { cache = { data: report, ts: now }; }
  return report || cache.data;
}

// ─── HTTP SERVER ─────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS — allow any origin so the React dashboard can call this
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (url.pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", ts: new Date().toISOString() }));
    return;
  }

  if (url.pathname === "/api/report") {
    const report = getCachedReport();
    if (!report) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Data unavailable" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(report));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => {
  console.log(`\n🐕  DOG Intelligence API running`);
  console.log(`    http://localhost:${PORT}/api/report`);
  console.log(`    http://localhost:${PORT}/api/health`);
  console.log(`    Cache TTL: ${CACHE_TTL / 1000}s\n`);
});
