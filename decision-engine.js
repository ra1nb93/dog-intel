/**
 * DOG•GO•TO•THE•MOON — Decision Engine v2
 *
 * Pack Index 0-100 calcolato su:
 * - Liquidity:  spread + bid depth
 * - Momentum:   RSI(14) + EMA(9/21) crossover + VWAP distance
 * - Risk:       ask walls + volatility
 * - Whale:      volume-weighted buy vs sell pressure
 *
 * Decisioni: WATCH_BUY / HOLD / WATCH_SELL / RISK_OFF
 */

export const DECISIONS = {
  WATCH_BUY:  "WATCH_BUY",
  HOLD:       "HOLD",
  WATCH_SELL: "WATCH_SELL",
  RISK_OFF:   "RISK_OFF",
};

export const TRADE_SIZE_USD = 500;

// ─── PACK INDEX HISTORY (in-memory, ultimi 20 valori) ────────────────────────
const packHistory = [];

export function getPackHistory() {
  return [...packHistory];
}

// ─── INDICATORI TECNICI ───────────────────────────────────────────────────────

/**
 * RSI(14) — Relative Strength Index
 * Input: array di prezzi close
 * Output: 0-100
 */
export function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50; // neutro se dati insufficienti

  let gains = 0;
  let losses = 0;

  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains  += diff;
    else           losses -= diff;
  }

  const avgGain = gains  / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;
  const rs  = avgGain / avgLoss;
  return parseFloat((100 - (100 / (1 + rs))).toFixed(2));
}

/**
 * EMA — Exponential Moving Average
 * Input: array di prezzi, period
 * Output: valore EMA corrente
 */
export function calcEMA(prices, period) {
  if (prices.length < period) return prices.at(-1);
  const k = 2 / (period + 1);
  let ema  = prices.slice(0, period).reduce((s, p) => s + p, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

/**
 * Volatilità: deviazione standard dei rendimenti percentuali
 */
export function calcVolatility(closes) {
  if (closes.length < 2) return 0;
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / returns.length;
  return Math.sqrt(variance) * 100; // in %
}

// ─── PACK INDEX v2 ────────────────────────────────────────────────────────────

export function computePackIndex(ticker, book, trades, ohlc) {
  // ── 1. LIQUIDITY SCORE (0-25) ──
  // Spread basso + buona bid depth = liquidità alta
  const spreadScore  = Math.max(0, 25 - (book.spreadPct * 18));
  const bidLiqScore  = Math.min(12.5, (book.bidLiq1pct / 1_000_000) * 4);
  const liquidityScore = Math.min(25, (spreadScore + bidLiqScore) / 2 * 1.5);

  // ── 2. MOMENTUM SCORE (0-25) — usa OHLC per RSI e EMA ──
  let momentumScore = 12; // neutro di default

  if (ohlc && ohlc.length >= 20) {
    const closes = ohlc.map(c => parseFloat(c[4])); // indice 4 = close

    // RSI(14)
    const rsi   = calcRSI(closes);
    // RSI < 30 = ipervenduto (bullish), RSI > 70 = ipercomprato (bearish)
    const rsiScore = rsi < 30 ? 20
      : rsi < 45 ? 15
      : rsi < 55 ? 10
      : rsi < 70 ? 7
      : 3;

    // EMA crossover: EMA9 vs EMA21
    const ema9  = calcEMA(closes, 9);
    const ema21 = calcEMA(closes, 21);
    const emaScore = ema9 > ema21 ? 5 : 0; // golden cross = bullish

    momentumScore = Math.min(25, rsiScore + emaScore);

    // Bonus: prezzo sopra VWAP
    if (ticker.last > ticker.vwap24h * 1.003) momentumScore = Math.min(25, momentumScore + 3);
    if (ticker.last < ticker.vwap24h * 0.997) momentumScore = Math.max(0, momentumScore - 3);

  } else {
    // Fallback senza OHLC: usa buy pressure e VWAP
    const pressureScore = (trades.buyPressure / 100) * 15;
    const vwapDist = ticker.last > ticker.vwap24h
      ? Math.min(10, ((ticker.last - ticker.vwap24h) / ticker.vwap24h) * 1000)
      : 0;
    momentumScore = Math.min(25, pressureScore + vwapDist);
  }

  // ── 3. RISK SCORE inverted (0-25) ──
  // Ask walls vicine = rischio alto = score basso
  // Volatilità alta = score basso
  let riskScore = 20; // base ottimistica

  const nearAskWalls = book.askWalls?.filter(
    w => w.price < ticker.last * 1.015 // entro 1.5% dal prezzo
  ) || [];
  riskScore -= nearAskWalls.length * 7;

  // Volatilità da OHLC
  if (ohlc && ohlc.length >= 10) {
    const closes    = ohlc.map(c => parseFloat(c[4]));
    const volatility = calcVolatility(closes.slice(-24)); // ultime 24 ore
    if (volatility > 3)      riskScore -= 8;
    else if (volatility > 1.5) riskScore -= 4;
    else if (volatility < 0.5) riskScore += 5; // bassa volatilità = stabilità
  }

  // Spread anomalo = rischio
  if (book.spreadPct > 0.8) riskScore -= 10;

  riskScore = Math.min(25, Math.max(0, riskScore));

  // ── 4. WHALE SCORE pesato per volume (0-25) ──
  // Peso le whale per volume invece di contarle
  const whaleBuyVol  = (trades.whaleTrades || [])
    .filter(t => t.side === "BUY")
    .reduce((s, t) => s + t.volume, 0);
  const whaleSellVol = (trades.whaleTrades || [])
    .filter(t => t.side === "SELL")
    .reduce((s, t) => s + t.volume, 0);
  const totalWhaleVol = whaleBuyVol + whaleSellVol;

  let whaleScore = 12; // neutro se nessuna whale
  if (totalWhaleVol > 0) {
    const whaleBuyRatio = whaleBuyVol / totalWhaleVol; // 0-1
    whaleScore = Math.round(whaleBuyRatio * 25);
  }

  // ── TOTALE ──
  const total = Math.round(
    Math.min(100, Math.max(0,
      liquidityScore + momentumScore + riskScore + whaleScore
    ))
  );

  // Calcola RSI e EMA per esporli nella dashboard
  let rsi = null, ema9 = null, ema21 = null;
  if (ohlc && ohlc.length >= 20) {
    const closes = ohlc.map(c => parseFloat(c[4]));
    rsi  = calcRSI(closes);
    ema9  = calcEMA(closes, 9);
    ema21 = calcEMA(closes, 21);
  }

  const result = {
    total,
    liquidity: Math.round(liquidityScore),
    momentum:  Math.round(momentumScore),
    risk:      Math.round(riskScore),
    whale:     Math.round(whaleScore),
    indicators: {
      rsi,
      ema9,
      ema21,
      emaCross: ema9 && ema21 ? (ema9 > ema21 ? "GOLDEN" : "DEATH") : null,
      whaleBuyVol,
      whaleSellVol,
      whaleBuyRatio: totalWhaleVol > 0
        ? parseFloat((whaleBuyVol / totalWhaleVol * 100).toFixed(1))
        : null,
    },
  };

  // Aggiorna history
  packHistory.push({ ts: Date.now(), score: total });
  if (packHistory.length > 20) packHistory.shift();

  // Calcola trend (ultimi 5 valori)
  if (packHistory.length >= 3) {
    const recent = packHistory.slice(-5).map(h => h.score);
    const trend  = recent.at(-1) - recent[0];
    result.trend = trend > 3 ? "UP" : trend < -3 ? "DOWN" : "FLAT";
  } else {
    result.trend = "FLAT";
  }

  return result;
}

// ─── DECISION ENGINE ─────────────────────────────────────────────────────────

export function decide(packIndex, ticker, book, trades, paperStatus) {
  const score      = packIndex.total;
  const hasDog     = (paperStatus?.balances?.DOG?.total || 0) > 0;
  const dogBalance = paperStatus?.balances?.DOG?.total    || 0;
  const usdBalance = paperStatus?.balances?.USD?.available || 0;
  const rsi        = packIndex.indicators?.rsi;
  const emaCross   = packIndex.indicators?.emaCross;

  let decision, reason, action;

  // RISK_OFF — condizioni anomale
  if (book.spreadPct > 1.0) {
    decision = DECISIONS.RISK_OFF;
    reason   = `Spread anomalo (${book.spreadPct}%) — mercato illiquido`;
    action   = "Stay out — wait for normal spread";
  }
  // RISK_OFF — RSI ipercomprato estremo
  else if (rsi && rsi > 80 && hasDog) {
    decision = DECISIONS.WATCH_SELL;
    reason   = `RSI ${rsi} — ipercomprato — segnale di uscita forte`;
    action   = `Paper sell ${Math.floor(dogBalance)} DOG`;
  }
  // WATCH_BUY — score alto + RSI non ipercomprato
  else if (score >= 65 && !hasDog && usdBalance >= TRADE_SIZE_USD) {
    const rsiOk = !rsi || rsi < 70;
    if (rsiOk) {
      decision = DECISIONS.WATCH_BUY;
      const reasons = [`Pack Index ${score}/100`];
      if (rsi)       reasons.push(`RSI ${rsi}`);
      if (emaCross)  reasons.push(`EMA ${emaCross} cross`);
      reason = reasons.join(" · ");
      action = `Paper buy ~${Math.floor(TRADE_SIZE_USD / ticker.last)} DOG ($${TRADE_SIZE_USD})`;
    } else {
      decision = DECISIONS.HOLD;
      reason   = `Pack Index ${score}/100 — RSI ${rsi} ipercomprato, attendi`;
      action   = "Wait for RSI cooldown";
    }
  }
  // WATCH_SELL — score basso + RSI ipervenduto non è ancora bottom (attendi)
  else if (score <= 35 && hasDog) {
    decision = DECISIONS.WATCH_SELL;
    const reasons = [`Pack Index ${score}/100`];
    if (rsi)      reasons.push(`RSI ${rsi}`);
    if (emaCross === "DEATH") reasons.push("EMA death cross");
    reason = reasons.join(" · ");
    action = `Paper sell ${Math.floor(dogBalance)} DOG`;
  }
  // HOLD
  else {
    decision = DECISIONS.HOLD;
    const reasons = [`Pack Index ${score}/100`];
    if (rsi)     reasons.push(`RSI ${rsi}`);
    if (packIndex.trend === "UP")   reasons.push("trend ↑");
    if (packIndex.trend === "DOWN") reasons.push("trend ↓");
    reason = reasons.join(" · ");
    action = hasDog ? "Hold position" : "Wait for entry signal";
  }

  return {
    decision, reason, action, score,
    hasDog, dogBalance, usdBalance,
    rsi, emaCross,
    trend: packIndex.trend,
  };
}