/**
 * DOG•GO•TO•THE•MOON — Intelligence + Trading Agent API v4
 *
 * GET  /api/report              → full intelligence report (cached 60s)
 * GET  /api/paper/status        → paper account status + P&L
 * GET  /api/paper/history       → paper trade history
 * POST /api/paper/buy           → execute paper buy
 * POST /api/paper/sell          → execute paper sell
 * POST /api/live/portfolio      → get real Kraken portfolio (DOG balance + history + open orders)
 * GET  /api/health              → server status
 */

import { execSync }                                 from "child_process";
import { readFileSync }                              from "fs";
import http                                         from "http";
import { URL }                                      from "url";
import { computePackIndex, decide, TRADE_SIZE_USD } from "./decision-engine.js";

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const PORT      = 3001;
const PAIR      = "DOG/USD";
const WHALE_MIN = 500_000;
const WALL_MIN  = 5_000_000;
const CACHE_TTL = 60_000;

// Kraken DOGUSD limits
const KRAKEN_DOG_ORDER_MIN = 6200;
const KRAKEN_FEE_TAKER     = 0.004; // 0.40% taker fee at volume 0

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

// CLI autenticato — passa il secret via stdin (sicuro, non esposto nel process listing)
function cliAuth(cmd, apiKey, apiSecret) {
  try {
    const out = execSync(
      `echo "${apiSecret}" | kraken ${cmd} --api-key "${apiKey}" --api-secret-stdin -o json`,
      { encoding: "utf8", timeout: 15_000, shell: "/bin/sh" }
    );
    return JSON.parse(out);
  } catch (e) {
    const msg = e.message;
    if (msg.includes("Invalid key") || msg.includes("EAPI:Invalid key"))
      throw new Error("Invalid API credentials");
    if (msg.includes("Permission denied") || msg.includes("EAPI:Invalid nonce"))
      throw new Error("API key missing required permissions");
    throw new Error(msg.split("\n")[0]);
  }
}

function fmt(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

function pct(a, b) { return parseFloat((((a - b) / b) * 100).toFixed(2)); }

// ─── MARKET DATA ─────────────────────────────────────────────────────────────

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
    bidLiq1pct: bidLiq, askLiq1pct: askLiq, mid,
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

function fetchOHLC(interval = 60, count = 48) {
  const d = cli(`ohlc ${PAIR} --interval ${interval}`);
  if (!d) return null;
  return (d[PAIR] || []).slice(-count);
}

// ─── BTC NETWORK CONTEXT ─────────────────────────────────────────────────────

let btcCache = { data: null, ts: 0 };
const BTC_CACHE_TTL = 120_000; // 2 minutes

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'dog-intel/1.0' } });
  return res.json();
}

async function fetchBTCContext() {
  const now = Date.now();
  if (btcCache.data && now - btcCache.ts < BTC_CACHE_TTL) return btcCache.data;
  try {
    const [fees, blocks, price] = await Promise.all([
      fetchJSON('https://mempool.space/api/v1/fees/recommended'),
      fetchJSON('https://mempool.space/api/blocks'),
      fetchJSON('https://mempool.space/api/v1/prices'),
    ]);
    const lastBlock = blocks[0];
    const data = {
      fees: {
        fast:     fees.fastestFee,
        medium:   fees.halfHourFee,
        slow:     fees.hourFee,
        economy:  fees.economyFee,
      },
      mempool: {
        blocks: blocks.slice(0, 4).map(b => ({
          height:   b.height,
          txCount:  b.tx_count,
          size:     (b.size / 1_000_000).toFixed(2),
          time:     b.timestamp,
        })),
      },
      btcPrice: price?.USD || null,
      lastBlock: {
        height:  lastBlock.height,
        txCount: lastBlock.tx_count,
        time:    lastBlock.timestamp,
      },
    };
    btcCache = { data, ts: now };
    return data;
  } catch(e) {
    console.warn('[BTC CONTEXT]', e.message);
    return btcCache.data || null;
  }
}


// ─── TELEGRAM ALERTS ─────────────────────────────────────────────────────────

const TG_TOKEN   = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

let lastAlertState = { decision: null, rsiAlert: null };

async function sendTelegram(msg) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text: msg,
        parse_mode: 'HTML',
      }),
    });
    console.log('[TELEGRAM] Sent:', msg.slice(0, 60));
  } catch(e) {
    console.warn('[TELEGRAM] Failed:', e.message);
  }
}

function checkAlerts(report) {
  if (!report) return;
  const { packIndex, price } = report;
  const score = packIndex?.total;
  const rsi   = packIndex?.indicators?.rsi;
  const dec   = report.agent?.decision;

  console.log(`[alerts] decision=${dec} score=${score} rsi=${rsi?.toFixed(1)} tg=${!!TG_TOKEN}`);

  // Decision change alert
  if (dec && dec !== lastAlertState.decision) {
    if (dec === 'WATCH_BUY') {
      sendTelegram(
        `🟢 <b>WATCH BUY</b> — DOG•GO•TO•THE•MOON
` +
        `Pack Index: ${score}/100
` +
        `Price: $${price?.last?.toFixed(6)}
` +
        `RSI: ${rsi?.toFixed(1)}
` +
        `dog-intel.onrender.com`
      );
    } else if (dec === 'WATCH_SELL') {
      sendTelegram(
        `🔴 <b>WATCH SELL</b> — DOG•GO•TO•THE•MOON
` +
        `Pack Index: ${score}/100
` +
        `Price: $${price?.last?.toFixed(6)}
` +
        `RSI: ${rsi?.toFixed(1)}
` +
        `dog-intel.onrender.com`
      );
    } else if (dec === 'RISK_OFF') {
      sendTelegram(
        `⛔ <b>RISK OFF</b> — Spread anomalo
` +
        `Spread: ${report.orderbook?.spreadPct}%
` +
        `dog-intel.onrender.com`
      );
    }
    lastAlertState.decision = dec;
  }

  // RSI alerts (one-shot, reset when crosses back)
  if (rsi) {
    if (rsi > 80 && lastAlertState.rsiAlert !== 'overbought') {
      sendTelegram(
        `⚠️ <b>RSI OVERBOUGHT</b> — RSI ${rsi.toFixed(1)}
` +
        `DOG/USD: $${price?.last?.toFixed(6)}
` +
        `dog-intel.onrender.com`
      );
      lastAlertState.rsiAlert = 'overbought';
    } else if (rsi < 25 && lastAlertState.rsiAlert !== 'oversold') {
      sendTelegram(
        `💎 <b>RSI OVERSOLD</b> — RSI ${rsi.toFixed(1)}
` +
        `DOG/USD: $${price?.last?.toFixed(6)}
` +
        `dog-intel.onrender.com`
      );
      lastAlertState.rsiAlert = 'oversold';
    } else if (rsi > 30 && rsi < 70) {
      lastAlertState.rsiAlert = null; // reset
    }
  }
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
    const out = execSync(`kraken paper buy ${PAIR} ${Math.floor(volume)} -o json`,
      { encoding: "utf8", timeout: 10_000 });
    return JSON.parse(out);
  } catch (e) { return { error: e.message }; }
}

function executePaperSell(volume) {
  try {
    const out = execSync(`kraken paper sell ${PAIR} ${Math.floor(volume)} -o json`,
      { encoding: "utf8", timeout: 10_000 });
    return JSON.parse(out);
  } catch (e) { return { error: e.message }; }
}

// ─── LIVE PORTFOLIO (read-only) ───────────────────────────────────────────────

function fetchLivePortfolio(apiKey, apiSecret) {
  // 1. Balance
  const balance = cliAuth("balance", apiKey, apiSecret);
  const dog     = parseFloat(balance?.DOG || 0);

  // 2. Trade history DOG
  let tradeHistory = [];
  try {
    const hist = cliAuth("trades-history", apiKey, apiSecret);
    const trades = hist?.trades || {};
    tradeHistory = Object.values(trades)
      .filter(t => t.pair === "DOGUSD" || t.pair === "DOG/USD")
      .sort((a, b) => b.time - a.time)
      .slice(0, 20)
      .map(t => ({
        side:   t.type === "buy" ? "BUY" : "SELL",
        volume: parseFloat(t.vol),
        price:  parseFloat(t.price),
        cost:   parseFloat(t.cost),
        fee:    parseFloat(t.fee),
        time:   new Date(t.time * 1000).toISOString(),
      }));
  } catch(e) { console.warn("[TRADE HISTORY]", e.message); }

  // 3. Open orders
  let openOrders = [];
  try {
    const orders = cliAuth("open-orders", apiKey, apiSecret);
    const all = orders?.open || {};
    openOrders = Object.entries(all)
      .filter(([, o]) => o.descr?.pair?.includes("DOG"))
      .map(([id, o]) => ({
        id,
        side:   o.descr.type,
        type:   o.descr.ordertype,
        volume: parseFloat(o.vol),
        price:  parseFloat(o.descr.price || 0),
        status: o.status,
      }));
  } catch(e) { console.warn("[OPEN ORDERS]", e.message); }

  // 4. P&L calcolato sui trade storici
  let realizedPnl = 0;
  let totalBought = 0, totalCostBuy = 0;
  let totalSold   = 0, totalCostSell = 0;

  tradeHistory.forEach(t => {
    if (t.side === "BUY") {
      totalBought  += t.volume;
      totalCostBuy += t.cost + t.fee;
    } else {
      totalSold    += t.volume;
      totalCostSell += t.cost - t.fee;
    }
  });

  if (totalBought > 0) {
    const avgBuyPrice = totalCostBuy / totalBought;
    realizedPnl = totalCostSell - (totalSold * avgBuyPrice);
  }

  // 5. Unrealized P&L (se hai DOG, vs prezzo attuale)
  const ticker = fetchTicker();
  const unrealizedPnl = ticker && totalBought > totalSold && totalCostBuy > 0
    ? (dog * ticker.last) - ((totalCostBuy / totalBought) * dog)
    : null;

  return {
    dog,
    dogFormatted: fmt(dog),
    tradeHistory,
    openOrders,
    realizedPnl:   parseFloat(realizedPnl.toFixed(4)),
    unrealizedPnl: unrealizedPnl !== null ? parseFloat(unrealizedPnl.toFixed(4)) : null,
    avgBuyPrice:   totalBought > 0 ? parseFloat((totalCostBuy / totalBought).toFixed(8)) : null,
    currentPrice:  ticker?.last || null,
    totalTradesFound: tradeHistory.length,
  };
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

async function buildReport() {
  console.log("[fetch] pulling fresh data from Kraken CLI...");
  const ticker = fetchTicker();
  const book   = fetchOrderbook();
  const trades = fetchTrades();
  if (!ticker || !book || !trades) {
    console.warn("[fetch] failed: ticker=%s book=%s trades=%s", !!ticker, !!book, !!trades);
    return null;
  }
  const ohlc      = fetchOHLC();
  const paper     = fetchPaperStatus();
  const packIndex = computePackIndex(ticker, book, trades, ohlc);
  const agent     = decide(packIndex, ticker, book, trades, paper);
  const signals   = analyze(ticker, book, trades);
  return {
    timestamp: new Date().toISOString(),
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
      asks: book.asks, bids: book.bids,
      bidWalls: book.bidWalls, askWalls: book.askWalls,
    },
    whales: {
      trades: trades.whaleTrades.slice(0, 10),
      marketWhales: trades.marketWhales.slice(-5),
      buyPressure: trades.buyPressure, largestTrade: trades.largest,
      recent: trades.trades.slice(-20).reverse(),
    },
    signals, packIndex, agent,
    paper: paper || null,
    ohlc: ohlc ? ohlc.slice(-48) : null,
    btc: await fetchBTCContext().catch(e => { console.warn("[btc] failed:", e.message); return null; }),
  };
  checkAlerts(report);
  return report;
}

async function getCachedReport() {
  const now = Date.now();
  if (cache.data && now - cache.ts < CACHE_TTL) return cache.data;
  const report = await buildReport();
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
  const url  = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  // GET / → serve dashboard
  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    try {
      const html = readFileSync(new URL('./index.html', import.meta.url));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    } catch(e) {
      res.writeHead(404); return res.end("index.html not found");
    }
  }

  // GET /api/health
  if (req.method === "GET" && path === "/api/health")
    return json(res, 200, { status: "ok", ts: new Date().toISOString() });

  // GET /api/ohlc?interval=15|60|240
  if (req.method === "GET" && path === "/api/ohlc") {
    const interval = parseInt(url.searchParams.get("interval") || "60");
    const count    = interval === 15 ? 96 : interval === 240 ? 42 : 48;
    const valid    = [15, 60, 240].includes(interval);
    if (!valid) return json(res, 400, { error: "interval must be 15, 60, or 240" });
    const candles = fetchOHLC(interval, count);
    return candles ? json(res, 200, { interval, candles }) : json(res, 503, { error: "OHLC unavailable" });
  }

  // GET /api/btc
  if (req.method === "GET" && path === "/api/btc") {
    const btc = await fetchBTCContext();
    return btc ? json(res, 200, btc) : json(res, 503, { error: "BTC data unavailable" });
  }

  // GET /api/report
  if (req.method === "GET" && path === "/api/report") {
    const report = await getCachedReport();
    return report ? json(res, 200, report) : json(res, 503, { error: "Data unavailable" });
  }

  // GET /api/paper/status
  if (req.method === "GET" && path === "/api/paper/status") {
    const s = fetchPaperStatus();
    return s ? json(res, 200, s) : json(res, 503, { error: "Unavailable" });
  }

  // GET /api/paper/history
  if (req.method === "GET" && path === "/api/paper/history") {
    const h = fetchPaperHistory();
    return h ? json(res, 200, h) : json(res, 503, { error: "Unavailable" });
  }

  // POST /api/paper/buy
  if (req.method === "POST" && path === "/api/paper/buy") {
    const body   = await readBody(req);
    const ticker = fetchTicker();
    if (!ticker) return json(res, 503, { error: "Cannot fetch price" });
    const volume = Math.floor((body.usd || TRADE_SIZE_USD) / ticker.last);
    const result = executePaperBuy(volume);
    cache.ts = 0;
    return json(res, 200, { ...result, volume, estimatedPrice: ticker.last });
  }

  // POST /api/paper/sell
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

  // POST /api/live/portfolio — read-only, no trading
  if (req.method === "POST" && path === "/api/live/portfolio") {
    const body = await readBody(req);
    try {
      requireCredentials(body);
      const portfolio = fetchLivePortfolio(body.apiKey, body.apiSecret);
      return json(res, 200, portfolio);
    } catch(e) {
      return json(res, 400, { error: e.message });
    }
  }

  return json(res, 404, { error: "Not found" });
});

server.listen(PORT, '0.0.0.0', () => {
  // Auto-inizializza paper trading se non esiste
  try {
    execSync("kraken paper status -o json", { encoding: "utf8", timeout: 5_000 });
    console.log("[paper] Account already initialized");
  } catch(e) {
    try {
      execSync("kraken paper init", { encoding: "utf8", timeout: 5_000 });
      console.log("[paper] Account initialized with $10,000");
    } catch(e2) {
      console.warn("[paper] Could not initialize:", e2.message);
    }
  }

  console.log(`\n🐕  DOG Intelligence + Trading Agent v4`);
  console.log(`    http://localhost:${PORT}/api/report`);
  console.log(`\n    PAPER TRADING`);
  console.log(`    POST /api/paper/buy`);
  console.log(`    POST /api/paper/sell`);
  console.log(`\n    LIVE PORTFOLIO (read-only)`);
  console.log(`    POST /api/live/portfolio`);
  console.log(`\n    Cache TTL: ${CACHE_TTL / 1000}s\n`);
});