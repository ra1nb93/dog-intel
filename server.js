/**
 * DOG•GO•TO•THE•MOON — Intelligence + Trading Agent API
 *
 * Endpoints:
 *   GET  /api/report         → full intelligence report (cached 60s)
 *   GET  /api/paper/status   → paper account status + P&L
 *   GET  /api/paper/history  → trade history
 *   POST /api/paper/buy      → execute paper buy
 *   POST /api/paper/sell     → execute paper sell
 *   GET  /api/health         → server status
 */

import { execSync }                                    from "child_process";
import http                                            from "http";
import { URL }                                         from "url";
import { computePackIndex, decide, TRADE_SIZE_USD }    from "./decision-engine.js";

const PORT      = 3001;
const PAIR      = "DOG/USD";
const WHALE_MIN = 500_000;
const WALL_MIN  = 5_000_000;
const CACHE_TTL = 60_000;

let cache = { data: null, ts: 0 };

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

function fetchTicker() {
  const d = cli(`ticker ${PAIR}`);
  if (!d) return null;
  const t = d[PAIR];
  return {
    ask: parseFloat(t.a[0]), bid: parseFloat(t.b[0]),
    last: parseFloat(t.c[0]), high24h: parseFloat(t.h[1]),
    low24h: parseFloat(t.l[1]), open: parseFloat(t.o),
    vwap24h: parseFloat(t.p[1]), volume24h: parseFloat(t.v[1]),
    trades24h: t.t[1],
  };
}

function fetchOrderbook() {
  const d = cli(`orderbook ${PAIR}`);
  if (!d) return null;
  const book = d[PAIR];
  const asks = book.asks.map(([p, s, ts]) => ({ price: parseFloat(p), size: parseFloat(s), ts }));
  const bids = book.bids.map(([p, s, ts]) => ({ price: parseFloat(p), size: parseFloat(s), ts }));
  const askWalls  = asks.filter(a => a.size >= WALL_MIN);
  const bidWalls  = bids.filter(b => b.size >= WALL_MIN);
  const spread    = asks[0].price - bids[0].price;
  const spreadPct = parseFloat(((spread / asks[0].price) * 100).toFixed(4));
  const mid       = (asks[0].price + bids[0].price) / 2;
  const range     = mid * 0.01;
  const bidLiq    = bids.filter(b => b.price >= mid - range).reduce((s, b) => s + b.size, 0);
  const askLiq    = asks.filter(a => a.price <= mid + range).reduce((s, a) => s + a.size, 0);
  return {
    asks: asks.slice(0, 15), bids: bids.slice(0, 15),
    askWalls, bidWalls, spread, spreadPct,
    bidLiq1pct: bidLiq, askLiq1pct: askLiq, mid
  };
}

function fetchTrades() {
  const d = cli(`trades ${PAIR}`);
  if (!d) return null;
  const trades = d[PAIR].map(([price, volume, time, side, type, , id]) => ({
    price: parseFloat(price), volume: parseFloat(volume),
    time: parseFloat(time), side: side === "b" ? "BUY" : "SELL",
    type: type === "m" ? "MARKET" : "LIMIT",
    id: parseInt(id), usdVal: parseFloat(price) * parseFloat(volume),
  }));
  const whaleTrades  = trades.filter(t => t.volume >= WHALE_MIN).sort((a, b) => b.volume - a.volume);
  const recent       = trades.slice(-100);
  const buyVol       = recent.filter(t => t.side === "BUY").reduce((s, t) => s + t.volume, 0);
  const sellVol      = recent.filter(t => t.side === "SELL").reduce((s, t) => s + t.volume, 0);
  const pressure     = buyVol / (buyVol + sellVol);
  const largest      = [...trades].sort((a, b) => b.volume - a.volume)[0];
  const marketWhales = trades.filter(t => t.type === "MARKET" && t.volume >= WHALE_MIN);
  return {
    trades: trades.slice(-50), whaleTrades, buyVol, sellVol,
    buyPressure: parseFloat((pressure * 100).toFixed(1)),
    largest, marketWhales,
  };
}

function fetchPaperStatus() {
  const status  = cli("paper status");
  const balance = cli("paper balance");
  if (!status || !balance) return null;
  return { ...status, balances: balance.balances };
}

function fetchPaperHistory() {
  return cli("paper history");
}

function executePaperBuy(volume) {
  try {
    const out = execSync(`kraken paper buy ${PAIR} ${Math.floor(volume)} -o json`, { encoding: "utf8", timeout: 10_000 });
    return JSON.parse(out);
  } catch (e) {
    return { error: e.message };
  }
}

function executePaperSell(volume) {
  try {
    const out = execSync(`kraken paper sell ${PAIR} ${Math.floor(volume)} -o json`, { encoding: "utf8", timeout: 10_000 });
    return JSON.parse(out);
  } catch (e) {
    return { error: e.message };
  }
}

function analyze(ticker, book, trades) {
  const signals = [];
  if (trades.buyPressure > 65)
    signals.push({ type: "BULLISH", msg: `Buy pressure ${trades.buyPressure.toFixed(0)}% in recent trades` });
  else if (trades.buyPressure < 35)
    signals.push({ type: "BEARISH", msg: `Sell pressure ${(100 - trades.buyPressure).toFixed(0)}% in recent trades` });
  if (book.askWalls?.length) {
    const top = [...book.askWalls].sort((a, b) => b.size - a.size)[0];
    signals.push({ type: "WALL", msg: `Ask wall ${fmt(top.size)} DOG @ $${top.price.toFixed(6)}` });
  }
  if (book.bidWalls?.length) {
    const top = [...book.bidWalls].sort((a, b) => b.size - a.size)[0];
    signals.push({ type: "SUPPORT", msg: `Bid wall ${fmt(top.size)} DOG @ $${top.price.toFixed(6)}` });
  }
  if (trades.marketWhales?.length) {
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

function buildReport() {
  console.log("[fetch] pulling fresh data from Kraken CLI...");
  const ticker = fetchTicker();
  const book   = fetchOrderbook();
  const trades = fetchTrades();
  if (!ticker || !book || !trades) return null;
  const paper     = fetchPaperStatus();
  const packIndex = computePackIndex(ticker, book, trades);
  const agent     = decide(packIndex, ticker, book, trades, paper);
  const signals   = analyze(ticker, book, trades);
  return {
    timestamp: new Date().toISOString(),
    price: { last: ticker.last, ask: ticker.ask, bid: ticker.bid,
      high24h: ticker.high24h, low24h: ticker.low24h,
      change24h: pct(ticker.last, ticker.open), vwap24h: ticker.vwap24h },
    volume: { total24h: ticker.volume24h, trades24h: ticker.trades24h,
      usd24h: ticker.volume24h * ticker.vwap24h },
    orderbook: { spread: book.spread, spreadPct: book.spreadPct,
      bidLiq1pct: book.bidLiq1pct, askLiq1pct: book.askLiq1pct,
      asks: book.asks, bids: book.bids, bidWalls: book.bidWalls, askWalls: book.askWalls },
    whales: { trades: trades.whaleTrades.slice(0, 10),
      marketWhales: trades.marketWhales.slice(-5),
      buyPressure: trades.buyPressure, largestTrade: trades.largest,
      recent: trades.trades.slice(-20).reverse() },
    signals,
    packIndex,
    agent,
    paper: paper || null,
  };
}

function getCachedReport() {
  const now = Date.now();
  if (cache.data && now - cache.ts < CACHE_TTL) return cache.data;
  const report = buildReport();
  if (report) cache = { data: report, ts: now };
  return report || cache.data;
}

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise(resolve => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url  = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
    return res.end();
  }

  if (req.method === "GET" && path === "/api/health")
    return json(res, 200, { status: "ok", ts: new Date().toISOString() });

  if (req.method === "GET" && path === "/api/report") {
    const report = getCachedReport();
    return report ? json(res, 200, report) : json(res, 503, { error: "Data unavailable" });
  }

  if (req.method === "GET" && path === "/api/paper/status") {
    const s = fetchPaperStatus();
    return s ? json(res, 200, s) : json(res, 503, { error: "Unavailable" });
  }

  if (req.method === "GET" && path === "/api/paper/history") {
    const h = fetchPaperHistory();
    return h ? json(res, 200, h) : json(res, 503, { error: "Unavailable" });
  }

  if (req.method === "POST" && path === "/api/paper/buy") {
    const body    = await readBody(req);
    const ticker  = fetchTicker();
    if (!ticker) return json(res, 503, { error: "Cannot fetch price" });
    const usd     = body.usd || TRADE_SIZE_USD;
    const volume  = Math.floor(usd / ticker.last);
    console.log(`[PAPER BUY] ${volume} DOG @ ~$${ticker.last}`);
    const result  = executePaperBuy(volume);
    cache.ts = 0;
    return json(res, 200, { ...result, volume, estimatedPrice: ticker.last });
  }

  if (req.method === "POST" && path === "/api/paper/sell") {
    const body    = await readBody(req);
    const paper   = fetchPaperStatus();
    if (!paper) return json(res, 503, { error: "Cannot fetch paper status" });
    const dogBal  = paper.balances?.DOG?.available || 0;
    if (dogBal <= 0) return json(res, 400, { error: "No DOG to sell" });
    const volume  = body.volume || dogBal;
    console.log(`[PAPER SELL] ${volume} DOG`);
    const result  = executePaperSell(volume);
    cache.ts = 0;
    return json(res, 200, { ...result, volume });
  }

  return json(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`\n🐕  DOG Intelligence + Trading Agent`);
  console.log(`    http://localhost:${PORT}/api/report`);
  console.log(`    http://localhost:${PORT}/api/paper/status`);
  console.log(`    http://localhost:${PORT}/api/paper/buy   [POST]`);
  console.log(`    http://localhost:${PORT}/api/paper/sell  [POST]`);
  console.log(`    Cache TTL: ${CACHE_TTL / 1000}s\n`);
});
