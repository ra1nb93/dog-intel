/**
 * DOG•GO•TO•THE•MOON — Intelligence + Trading Agent API v3
 *
 * GET  /api/report              → full intelligence report (cached 60s)
 * GET  /api/paper/status        → paper account status + P&L
 * GET  /api/paper/history       → paper trade history
 * POST /api/paper/buy           → execute paper buy
 * POST /api/paper/sell          → execute paper sell
 * POST /api/live/balance        → get real Kraken balance (requires credentials)
 * POST /api/live/buy            → execute real buy order (requires credentials)
 * POST /api/live/sell           → execute real sell order (requires credentials)
 * POST /api/live/validate-buy   → validate buy without executing
 * POST /api/live/validate-sell  → validate sell without executing
 * POST /api/live/cancel-all     → cancel all open orders (emergency)
 * GET  /api/health              → server status
 */

import { execSync }                                 from "child_process";
import http                                         from "http";
import { URL }                                      from "url";
import { computePackIndex, decide, TRADE_SIZE_USD } from "./decision-engine.js";

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const PORT      = 3001;
const PAIR_USD  = "DOG/USD";
const PAIR_EUR  = "DOG/EUR";
const WHALE_MIN = 500_000;
const WALL_MIN  = 5_000_000;
const CACHE_TTL = 60_000;

// Safety limits per live trading
const LIVE_MAX_POSITION_PCT = 0.20; // max 20% del balance DOG per trade
const LIVE_STOP_LOSS_PCT    = 0.05; // stop loss -5%
const LIVE_TAKE_PROFIT_PCT  = 0.10; // take profit +10%
const DEAD_MAN_SECONDS      = 60;   // cancel-after timeout

// ─── CACHE ───────────────────────────────────────────────────────────────────

let cache = { data: null, ts: 0 };

// ─── CLI HELPERS ─────────────────────────────────────────────────────────────

function cli(cmd) {
  try {
    const out = execSync(`kraken ${cmd} -o json`, { encoding: "utf8", timeout: 10_000 });
    return JSON.parse(out);
  } catch (e) {
    console.error(`[CLI ERROR] kraken ${cmd}:`, e.message);
    return null;
  }
}

// CLI con credenziali live — non salva mai le chiavi su disco
function cliLive(cmd, apiKey, apiSecret) {
  try {
    const out = execSync(
      `kraken ${cmd} --api-key "${apiKey}" --api-secret "${apiSecret}" -o json`,
      { encoding: "utf8", timeout: 15_000 }
    );
    return JSON.parse(out);
  } catch (e) {
    console.error(`[LIVE CLI ERROR] kraken ${cmd}:`, e.message);
    throw new Error(e.message.includes("Invalid key") ? "Invalid API credentials" : e.message);
  }
}

function fmt(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

function pct(a, b) { return parseFloat((((a - b) / b) * 100).toFixed(2)); }

// ─── MARKET DATA ─────────────────────────────────────────────────────────────

function fetchTicker(pair = PAIR_USD) {
  const d = cli(`ticker ${pair}`);
  if (!d) return null;
  const t = d[pair];
  return {
    ask: parseFloat(t.a[0]), bid: parseFloat(t.b[0]),
    last: parseFloat(t.c[0]), high24h: parseFloat(t.h[1]),
    low24h: parseFloat(t.l[1]), open: parseFloat(t.o),
    vwap24h: parseFloat(t.p[1]), volume24h: parseFloat(t.v[1]),
    trades24h: t.t[1], pair,
  };
}

function fetchOrderbook(pair = PAIR_USD) {
  const d = cli(`orderbook ${pair}`);
  if (!d) return null;
  const book = d[pair];
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
    bidLiq1pct: bidLiq, askLiq1pct: askLiq, mid,
  };
}

function fetchTrades(pair = PAIR_USD) {
  const d = cli(`trades ${pair}`);
  if (!d) return null;
  const trades = d[pair].map(([price, volume, time, side, type, , id]) => ({
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

function fetchOHLC(pair = PAIR_USD) {
  const d = cli(`ohlc ${pair} --interval 60`);
  if (!d) return null;
  return (d[pair] || []).slice(-48);
}

// ─── PAPER TRADING ───────────────────────────────────────────────────────────

function fetchPaperStatus() {
  const status  = cli("paper status");
  const balance = cli("paper balance");
  if (!status || !balance) return null;
  return { ...status, balances: balance.balances };
}

function fetchPaperHistory() { return cli("paper history"); }

function executePaperBuy(volume) {
  try {
    const out = execSync(`kraken paper buy ${PAIR_USD} ${Math.floor(volume)} -o json`, { encoding: "utf8", timeout: 10_000 });
    return JSON.parse(out);
  } catch (e) { return { error: e.message }; }
}

function executePaperSell(volume) {
  try {
    const out = execSync(`kraken paper sell ${PAIR_USD} ${Math.floor(volume)} -o json`, { encoding: "utf8", timeout: 10_000 });
    return JSON.parse(out);
  } catch (e) { return { error: e.message }; }
}

// ─── LIVE TRADING ─────────────────────────────────────────────────────────────

function getLiveBalance(apiKey, apiSecret) {
  return cliLive("balance", apiKey, apiSecret);
}

function executeLiveBuy(volume, pair, apiKey, apiSecret) {
  console.log(`[LIVE BUY] ${volume} ${pair}`);

  // Dead man's switch — cancella tutto dopo DEAD_MAN_SECONDS
  try {
    execSync(
      `kraken order cancel-after ${DEAD_MAN_SECONDS} --api-key "${apiKey}" --api-secret "${apiSecret}" -o json`,
      { encoding: "utf8", timeout: 10_000 }
    );
  } catch(e) { console.warn("[DEAD MAN SWITCH] Failed to set:", e.message); }

  return cliLive(`order buy ${pair} ${Math.floor(volume)} --type market --yes`, apiKey, apiSecret);
}

function executeLiveSell(volume, pair, apiKey, apiSecret) {
  console.log(`[LIVE SELL] ${volume} ${pair}`);

  try {
    execSync(
      `kraken order cancel-after ${DEAD_MAN_SECONDS} --api-key "${apiKey}" --api-secret "${apiSecret}" -o json`,
      { encoding: "utf8", timeout: 10_000 }
    );
  } catch(e) { console.warn("[DEAD MAN SWITCH] Failed to set:", e.message); }

  return cliLive(`order sell ${pair} ${Math.floor(volume)} --type market --yes`, apiKey, apiSecret);
}

function validateLiveOrder(side, volume, pair, apiKey, apiSecret) {
  return cliLive(`order ${side} ${pair} ${Math.floor(volume)} --type market --validate`, apiKey, apiSecret);
}

function cancelAllLiveOrders(apiKey, apiSecret) {
  return cliLive("order cancel-all --yes", apiKey, apiSecret);
}

// ─── SIGNALS ─────────────────────────────────────────────────────────────────

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

// ─── REPORT BUILDER ──────────────────────────────────────────────────────────

function buildReport(pair = PAIR_USD) {
  console.log(`[fetch] pulling fresh data from Kraken CLI (${pair})...`);
  const ticker = fetchTicker(pair);
  const book   = fetchOrderbook(pair);
  const trades = fetchTrades(pair);
  if (!ticker || !book || !trades) return null;
  const ohlc      = fetchOHLC(pair);
  const paper     = fetchPaperStatus();
  const packIndex = computePackIndex(ticker, book, trades, ohlc);
  const agent     = decide(packIndex, ticker, book, trades, paper);
  const signals   = analyze(ticker, book, trades);
  return {
    timestamp: new Date().toISOString(),
    pair,
    price: {
      last: ticker.last, ask: ticker.ask, bid: ticker.bid,
      high24h: ticker.high24h, low24h: ticker.low24h,
      change24h: pct(ticker.last, ticker.open), vwap24h: ticker.vwap24h,
    },
    volume: {
      total24h: ticker.volume24h, trades24h: ticker.trades24h,
      usd24h: ticker.volume24h * ticker.vwap24h,
    },
    orderbook: {
      spread: book.spread, spreadPct: book.spreadPct,
      bidLiq1pct: book.bidLiq1pct, askLiq1pct: book.askLiq1pct,
      asks: book.asks, bids: book.bids, bidWalls: book.bidWalls, askWalls: book.askWalls,
    },
    whales: {
      trades: trades.whaleTrades.slice(0, 10),
      marketWhales: trades.marketWhales.slice(-5),
      buyPressure: trades.buyPressure, largestTrade: trades.largest,
      recent: trades.trades.slice(-20).reverse(),
    },
    signals, packIndex, agent,
    paper: paper || null,
    liveConfig: {
      maxPositionPct: LIVE_MAX_POSITION_PCT,
      stopLossPct:    LIVE_STOP_LOSS_PCT,
      takeProfitPct:  LIVE_TAKE_PROFIT_PCT,
      deadManSeconds: DEAD_MAN_SECONDS,
    },
  };
}

function getCachedReport(pair = PAIR_USD) {
  const now = Date.now();
  if (cache.data && now - cache.ts < CACHE_TTL && cache.data.pair === pair) return cache.data;
  const report = buildReport(pair);
  if (report) cache = { data: report, ts: now };
  return report || cache.data;
}

// ─── HTTP HELPERS ─────────────────────────────────────────────────────────────

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

function requireCredentials(body) {
  if (!body.apiKey || !body.apiSecret) throw new Error("Missing apiKey or apiSecret");
  if (body.apiKey.length < 10)         throw new Error("Invalid apiKey");
  if (body.apiSecret.length < 10)      throw new Error("Invalid apiSecret");
}

// ─── SERVER ──────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url    = new URL(req.url, `http://localhost:${PORT}`);
  const path   = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  // ── GET /api/health ──
  if (req.method === "GET" && path === "/api/health")
    return json(res, 200, { status: "ok", ts: new Date().toISOString() });

  // ── GET /api/report ──
  if (req.method === "GET" && path === "/api/report") {
    const pair   = url.searchParams.get("pair") === "EUR" ? PAIR_EUR : PAIR_USD;
    const report = getCachedReport(pair);
    return report ? json(res, 200, report) : json(res, 503, { error: "Data unavailable" });
  }

  // ── PAPER ──
  if (req.method === "GET" && path === "/api/paper/status") {
    const s = fetchPaperStatus();
    return s ? json(res, 200, s) : json(res, 503, { error: "Unavailable" });
  }

  if (req.method === "GET" && path === "/api/paper/history") {
    const h = fetchPaperHistory();
    return h ? json(res, 200, h) : json(res, 503, { error: "Unavailable" });
  }

  if (req.method === "POST" && path === "/api/paper/buy") {
    const body   = await readBody(req);
    const ticker = fetchTicker();
    if (!ticker) return json(res, 503, { error: "Cannot fetch price" });
    const volume = Math.floor((body.usd || TRADE_SIZE_USD) / ticker.last);
    const result = executePaperBuy(volume);
    cache.ts = 0;
    return json(res, 200, { ...result, volume, estimatedPrice: ticker.last });
  }

  if (req.method === "POST" && path === "/api/paper/sell") {
    const body   = await readBody(req);
    const paper  = fetchPaperStatus();
    if (!paper) return json(res, 503, { error: "Cannot fetch paper status" });
    const dogBal = paper.balances?.DOG?.available || 0;
    if (dogBal <= 0) return json(res, 400, { error: "No DOG to sell" });
    const result = executePaperSell(body.volume || dogBal);
    cache.ts = 0;
    return json(res, 200, { ...result, volume: body.volume || dogBal });
  }

  // ── LIVE TRADING ──

  // POST /api/live/balance
  if (req.method === "POST" && path === "/api/live/balance") {
    const body = await readBody(req);
    try {
      requireCredentials(body);
      const balance = getLiveBalance(body.apiKey, body.apiSecret);
      const dog = parseFloat(balance?.DOG || 0);
      const eur = parseFloat(balance?.ZEUR || balance?.EUR || 0);
      const usd = parseFloat(balance?.ZUSD || balance?.USD || 0);
      return json(res, 200, { dog, eur, usd, raw: balance });
    } catch(e) {
      return json(res, 400, { error: e.message });
    }
  }

  // POST /api/live/validate-buy
  if (req.method === "POST" && path === "/api/live/validate-buy") {
    const body = await readBody(req);
    try {
      requireCredentials(body);
      const ticker = fetchTicker(body.pair === "EUR" ? PAIR_EUR : PAIR_USD);
      if (!ticker) return json(res, 503, { error: "Cannot fetch price" });
      const volume = Math.floor((body.usd || TRADE_SIZE_USD) / ticker.last);
      const pair   = body.pair === "EUR" ? PAIR_EUR : PAIR_USD;
      const result = validateLiveOrder("buy", volume, pair, body.apiKey, body.apiSecret);
      return json(res, 200, { ...result, volume, estimatedPrice: ticker.last, pair });
    } catch(e) {
      return json(res, 400, { error: e.message });
    }
  }

  // POST /api/live/validate-sell
  if (req.method === "POST" && path === "/api/live/validate-sell") {
    const body = await readBody(req);
    try {
      requireCredentials(body);
      const balance = getLiveBalance(body.apiKey, body.apiSecret);
      const dog = parseFloat(balance?.DOG || 0);
      if (dog <= 0) return json(res, 400, { error: "No DOG available" });
      const volume = Math.floor(dog * LIVE_MAX_POSITION_PCT);
      const pair   = body.pair === "EUR" ? PAIR_EUR : PAIR_USD;
      const result = validateLiveOrder("sell", volume, pair, body.apiKey, body.apiSecret);
      return json(res, 200, { ...result, volume, pair });
    } catch(e) {
      return json(res, 400, { error: e.message });
    }
  }

  // POST /api/live/buy
  if (req.method === "POST" && path === "/api/live/buy") {
    const body = await readBody(req);
    try {
      requireCredentials(body);
      if (!body.confirmed) return json(res, 400, { error: "Missing confirmed:true — safety check" });
      const ticker  = fetchTicker(body.pair === "EUR" ? PAIR_EUR : PAIR_USD);
      if (!ticker) return json(res, 503, { error: "Cannot fetch price" });
      const balance = getLiveBalance(body.apiKey, body.apiSecret);
      const availUSD = parseFloat(balance?.ZUSD || balance?.USD || 0);
      const availEUR = parseFloat(balance?.ZEUR || balance?.EUR || 0);
      const avail    = body.pair === "EUR" ? availEUR : availUSD;
      const tradeUSD = Math.min(body.usd || TRADE_SIZE_USD, avail * LIVE_MAX_POSITION_PCT);
      if (tradeUSD < 1) return json(res, 400, { error: "Insufficient balance" });
      const volume = Math.floor(tradeUSD / ticker.last);
      const pair   = body.pair === "EUR" ? PAIR_EUR : PAIR_USD;
      const result = executeLiveBuy(volume, pair, body.apiKey, body.apiSecret);
      console.log(`[LIVE BUY EXECUTED] ${volume} ${pair} @ ~${ticker.last}`);
      cache.ts = 0;
      return json(res, 200, {
        ...result, volume, estimatedPrice: ticker.last, pair,
        stopLoss:   parseFloat((ticker.last * (1 - LIVE_STOP_LOSS_PCT)).toFixed(8)),
        takeProfit: parseFloat((ticker.last * (1 + LIVE_TAKE_PROFIT_PCT)).toFixed(8)),
      });
    } catch(e) {
      return json(res, 400, { error: e.message });
    }
  }

  // POST /api/live/sell
  if (req.method === "POST" && path === "/api/live/sell") {
    const body = await readBody(req);
    try {
      requireCredentials(body);
      if (!body.confirmed) return json(res, 400, { error: "Missing confirmed:true — safety check" });
      const balance = getLiveBalance(body.apiKey, body.apiSecret);
      const dog     = parseFloat(balance?.DOG || 0);
      if (dog <= 0) return json(res, 400, { error: "No DOG available to sell" });
      const volume = body.volume || Math.floor(dog * LIVE_MAX_POSITION_PCT);
      const pair   = body.pair === "EUR" ? PAIR_EUR : PAIR_USD;
      const result = executeLiveSell(volume, pair, body.apiKey, body.apiSecret);
      console.log(`[LIVE SELL EXECUTED] ${volume} ${pair}`);
      cache.ts = 0;
      return json(res, 200, { ...result, volume, pair });
    } catch(e) {
      return json(res, 400, { error: e.message });
    }
  }

  // POST /api/live/cancel-all (emergency stop)
  if (req.method === "POST" && path === "/api/live/cancel-all") {
    const body = await readBody(req);
    try {
      requireCredentials(body);
      const result = cancelAllLiveOrders(body.apiKey, body.apiSecret);
      return json(res, 200, { ...result, message: "All orders cancelled" });
    } catch(e) {
      return json(res, 400, { error: e.message });
    }
  }

  return json(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`\n🐕  DOG Intelligence + Trading Agent v3`);
  console.log(`    http://localhost:${PORT}/api/report`);
  console.log(`    http://localhost:${PORT}/api/report?pair=EUR`);
  console.log(`\n    PAPER TRADING`);
  console.log(`    POST /api/paper/buy`);
  console.log(`    POST /api/paper/sell`);
  console.log(`\n    LIVE TRADING (requires API credentials)`);
  console.log(`    POST /api/live/balance`);
  console.log(`    POST /api/live/validate-buy`);
  console.log(`    POST /api/live/buy`);
  console.log(`    POST /api/live/sell`);
  console.log(`    POST /api/live/cancel-all  ← emergency stop`);
  console.log(`\n    Safety: stop-loss -${LIVE_STOP_LOSS_PCT*100}% | take-profit +${LIVE_TAKE_PROFIT_PCT*100}% | dead-man ${DEAD_MAN_SECONDS}s\n`);
});