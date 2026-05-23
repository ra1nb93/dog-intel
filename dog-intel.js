#!/usr/bin/env node

/**
 * DOG•GO•TO•THE•MOON — Intelligence Engine
 * Powered by Kraken CLI
 *
 * Usage:
 *   node dog-intel.js           → prints full report to console
 *   node dog-intel.js --json    → outputs raw JSON (for dashboard API)
 *   node dog-intel.js --watch   → refreshes every 60 seconds
 */

import { execSync } from "child_process";

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const PAIR          = "DOG/USD";
const WHALE_MIN     = 500_000;   // DOG threshold to flag as whale trade
const WALL_MIN      = 5_000_000; // DOG threshold to flag an order wall
const REFRESH_MS    = 60_000;
const KRAKEN        = "kraken";  // assumes kraken is in PATH

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function run(cmd) {
  try {
    const out = execSync(`${KRAKEN} ${cmd} -o json`, {
      encoding: "utf8",
      timeout: 10_000,
    });
    return JSON.parse(out);
  } catch (e) {
    console.error(`[ERROR] kraken ${cmd} failed:`, e.message);
    return null;
  }
}

function fmt(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

function usd(n) {
  return `$${(n).toFixed(2)}`;
}

function pct(a, b) {
  return (((a - b) / b) * 100).toFixed(2);
}

// ─── DATA FETCHERS ────────────────────────────────────────────────────────────

function fetchTicker() {
  const data = run(`ticker ${PAIR}`);
  if (!data) return null;
  const t = data[PAIR];
  return {
    ask:        parseFloat(t.a[0]),
    bid:        parseFloat(t.b[0]),
    last:       parseFloat(t.c[0]),
    high24h:    parseFloat(t.h[1]),
    low24h:     parseFloat(t.l[1]),
    open:       parseFloat(t.o),
    vwap24h:    parseFloat(t.p[1]),
    volume24h:  parseFloat(t.v[1]),
    trades24h:  t.t[1],
  };
}

function fetchOrderbook() {
  const data = run(`orderbook ${PAIR}`);
  if (!data) return null;
  const book = data[PAIR];

  // Parse asks and bids into { price, size, timestamp }
  const asks = book.asks.map(([p, s, ts]) => ({
    price: parseFloat(p),
    size:  parseFloat(s),
    ts,
  }));
  const bids = book.bids.map(([p, s, ts]) => ({
    price: parseFloat(p),
    size:  parseFloat(s),
    ts,
  }));

  // Detect walls
  const askWalls = asks.filter(a => a.size >= WALL_MIN);
  const bidWalls = bids.filter(b => b.size >= WALL_MIN);

  // Spread
  const spread    = asks[0].price - bids[0].price;
  const spreadPct = ((spread / asks[0].price) * 100).toFixed(4);

  // Total liquidity within 1% of mid
  const mid       = (asks[0].price + bids[0].price) / 2;
  const range     = mid * 0.01;
  const bidLiq    = bids
    .filter(b => b.price >= mid - range)
    .reduce((s, b) => s + b.size, 0);
  const askLiq    = asks
    .filter(a => a.price <= mid + range)
    .reduce((s, a) => s + a.size, 0);

  return { asks, bids, askWalls, bidWalls, spread, spreadPct, bidLiq, askLiq, mid };
}

function fetchTrades() {
  const data = run(`trades ${PAIR}`);
  if (!data) return null;
  const raw = data[PAIR];

  // Each trade: [price, volume, time, side("b"/"s"), type("l"/"m"), misc, id]
  const trades = raw.map(([price, volume, time, side, type, , id]) => ({
    price:  parseFloat(price),
    volume: parseFloat(volume),
    time:   parseFloat(time),
    side:   side === "b" ? "BUY" : "SELL",
    type:   type === "m" ? "MARKET" : "LIMIT",
    id:     parseInt(id),
    usdVal: parseFloat(price) * parseFloat(volume),
  }));

  // Whale trades
  const whaleTrades = trades
    .filter(t => t.volume >= WHALE_MIN)
    .sort((a, b) => b.volume - a.volume);

  // Buy/sell pressure (last 100 trades)
  const recent  = trades.slice(-100);
  const buyVol  = recent.filter(t => t.side === "BUY").reduce((s, t) => s + t.volume, 0);
  const sellVol = recent.filter(t => t.side === "SELL").reduce((s, t) => s + t.volume, 0);
  const pressure = buyVol / (buyVol + sellVol);

  // Largest single trade
  const largest = [...trades].sort((a, b) => b.volume - a.volume)[0];

  // Market orders (aggressive, whale signal)
  const marketWhales = trades.filter(t => t.type === "MARKET" && t.volume >= WHALE_MIN);

  return { trades, whaleTrades, buyVol, sellVol, pressure, largest, marketWhales };
}

// ─── ANALYSIS ENGINE ──────────────────────────────────────────────────────────

function analyze(ticker, book, trades) {
  const signals = [];

  // Signal: strong bid-side bias
  if (trades.pressure > 0.65)
    signals.push({ type: "BULLISH", msg: `Buy pressure ${(trades.pressure * 100).toFixed(0)}% in recent trades` });
  else if (trades.pressure < 0.35)
    signals.push({ type: "BEARISH", msg: `Sell pressure ${((1 - trades.pressure) * 100).toFixed(0)}% in recent trades` });

  // Signal: large ask wall blocking upside
  if (book.askWalls.length > 0) {
    const top = book.askWalls.sort((a, b) => b.size - a.size)[0];
    signals.push({ type: "WALL", msg: `Ask wall ${fmt(top.size)} DOG @ $${top.price.toFixed(6)}` });
  }

  // Signal: large bid wall providing support
  if (book.bidWalls.length > 0) {
    const top = book.bidWalls.sort((a, b) => b.size - a.size)[0];
    signals.push({ type: "SUPPORT", msg: `Bid wall ${fmt(top.size)} DOG @ $${top.price.toFixed(6)}` });
  }

  // Signal: aggressive market whale
  if (trades.marketWhales.length > 0) {
    const last = trades.marketWhales[trades.marketWhales.length - 1];
    signals.push({
      type: last.side === "BUY" ? "WHALE_BUY" : "WHALE_SELL",
      msg:  `Market ${last.side}: ${fmt(last.volume)} DOG (${usd(last.usdVal)})`,
    });
  }

  // Signal: price vs VWAP
  if (ticker.last > ticker.vwap24h * 1.005)
    signals.push({ type: "ABOVE_VWAP", msg: `Price ${pct(ticker.last, ticker.vwap24h)}% above 24h VWAP` });
  else if (ticker.last < ticker.vwap24h * 0.995)
    signals.push({ type: "BELOW_VWAP", msg: `Price ${pct(ticker.last, ticker.vwap24h)}% below 24h VWAP` });

  return signals;
}

// ─── OUTPUT ───────────────────────────────────────────────────────────────────

function buildReport(ticker, book, trades) {
  const signals = analyze(ticker, book, trades);
  const change24h = pct(ticker.last, ticker.open);
  const isUp = parseFloat(change24h) >= 0;

  return {
    timestamp:  new Date().toISOString(),
    price: {
      last:     ticker.last,
      ask:      ticker.ask,
      bid:      ticker.bid,
      high24h:  ticker.high24h,
      low24h:   ticker.low24h,
      change24h: parseFloat(change24h),
      vwap24h:  ticker.vwap24h,
    },
    volume: {
      total24h:   ticker.volume24h,
      trades24h:  ticker.trades24h,
      usd24h:     ticker.volume24h * ticker.vwap24h,
    },
    orderbook: {
      spread:     book.spread,
      spreadPct:  parseFloat(book.spreadPct),
      bidLiq1pct: book.bidLiq,
      askLiq1pct: book.askLiq,
      bidWalls:   book.bidWalls.map(w => ({ price: w.price, size: w.size })),
      askWalls:   book.askWalls.map(w => ({ price: w.price, size: w.size })),
    },
    whales: {
      trades:       trades.whaleTrades.slice(0, 10),
      marketWhales: trades.marketWhales.slice(-5),
      buyPressure:  parseFloat((trades.pressure * 100).toFixed(1)),
      largestTrade: trades.largest,
    },
    signals,
  };
}

function printReport(report) {
  const { price, volume, orderbook, whales, signals } = report;
  const arrow = price.change24h >= 0 ? "▲" : "▼";
  const col   = price.change24h >= 0 ? "\x1b[32m" : "\x1b[31m";
  const reset = "\x1b[0m";
  const gold  = "\x1b[33m";
  const dim   = "\x1b[2m";

  console.log("\n" + "─".repeat(60));
  console.log(`${gold}🐕  DOG•GO•TO•THE•MOON — Intelligence Report${reset}`);
  console.log(`${dim}${new Date(report.timestamp).toLocaleString()}${reset}`);
  console.log("─".repeat(60));

  console.log(`\n${gold}PRICE${reset}`);
  console.log(`  Last     ${col}$${price.last.toFixed(6)}  ${arrow} ${Math.abs(price.change24h)}% 24h${reset}`);
  console.log(`  Bid/Ask  $${price.bid.toFixed(6)} / $${price.ask.toFixed(6)}`);
  console.log(`  24h      H: $${price.high24h.toFixed(6)}  L: $${price.low24h.toFixed(6)}`);
  console.log(`  VWAP 24h $${price.vwap24h.toFixed(6)}`);

  console.log(`\n${gold}VOLUME${reset}`);
  console.log(`  24h      ${fmt(volume.total24h)} DOG  (${usd(volume.usd24h)})`);
  console.log(`  Trades   ${volume.trades24h}`);

  console.log(`\n${gold}ORDERBOOK${reset}`);
  console.log(`  Spread   ${orderbook.spreadPct}%`);
  console.log(`  Bid liq  ${fmt(orderbook.bidLiq1pct)} DOG within 1%`);
  console.log(`  Ask liq  ${fmt(orderbook.askLiq1pct)} DOG within 1%`);

  if (orderbook.askWalls.length) {
    console.log(`\n  ${"\x1b[31m"}ASK WALLS${reset}`);
    orderbook.askWalls
      .sort((a, b) => b.size - a.size)
      .forEach(w => console.log(`    $${w.price.toFixed(6)}  ${fmt(w.size)} DOG`));
  }
  if (orderbook.bidWalls.length) {
    console.log(`\n  ${"\x1b[32m"}BID WALLS${reset}`);
    orderbook.bidWalls
      .sort((a, b) => b.size - a.size)
      .forEach(w => console.log(`    $${w.price.toFixed(6)}  ${fmt(w.size)} DOG`));
  }

  console.log(`\n${gold}WHALE ACTIVITY${reset}`);
  console.log(`  Buy pressure  ${whales.buyPressure}%`);
  if (whales.trades.length) {
    console.log(`  Top trades:`);
    whales.trades.slice(0, 5).forEach(t => {
      const side = t.side === "BUY" ? "\x1b[32mBUY " : "\x1b[31mSELL";
      console.log(`    ${side}${reset}  ${fmt(t.volume)} DOG  @ $${t.price.toFixed(6)}  (${usd(t.usdVal)})`);
    });
  }

  if (signals.length) {
    console.log(`\n${gold}SIGNALS${reset}`);
    signals.forEach(s => {
      const icon = {
        BULLISH:    "🟢",
        BEARISH:    "🔴",
        WALL:       "🧱",
        SUPPORT:    "🛡️ ",
        WHALE_BUY:  "🐋",
        WHALE_SELL: "🐋",
        ABOVE_VWAP: "📈",
        BELOW_VWAP: "📉",
      }[s.type] || "•";
      console.log(`  ${icon}  ${s.msg}`);
    });
  }

  console.log("\n" + "─".repeat(60) + "\n");
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const args    = process.argv.slice(2);
  const asJson  = args.includes("--json");
  const watch   = args.includes("--watch");

  function run_once() {
    const ticker = fetchTicker();
    const book   = fetchOrderbook();
    const trades = fetchTrades();

    if (!ticker || !book || !trades) {
      console.error("Failed to fetch data. Is Kraken CLI installed and in PATH?");
      process.exit(1);
    }

    const report = buildReport(ticker, book, trades);

    if (asJson) {
      process.stdout.write(JSON.stringify(report, null, 2));
    } else {
      printReport(report);
    }

    return report;
  }

  run_once();

  if (watch) {
    console.log(`\nWatching... refreshing every ${REFRESH_MS / 1000}s. Ctrl+C to stop.\n`);
    setInterval(run_once, REFRESH_MS);
  }
}

main();
