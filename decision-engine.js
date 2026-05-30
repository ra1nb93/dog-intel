/**
 * DOG•GO•TO•THE•MOON — Decision Engine
 * Analizza i dati di mercato e genera raccomandazioni di trading
 */

// ─── COSTANTI ────────────────────────────────────────────────────────────────

export const DECISIONS = {
  WATCH_BUY:  "WATCH_BUY",
  HOLD:       "HOLD",
  WATCH_SELL: "WATCH_SELL",
  RISK_OFF:   "RISK_OFF",
};

// Quanto USD investire per ogni paper trade (5% del balance iniziale)
export const TRADE_SIZE_USD = 500;

// ─── PACK INDEX ──────────────────────────────────────────────────────────────
// Score 0-100 che sintetizza le condizioni di mercato

export function computePackIndex(ticker, book, trades) {
  // 1. LIQUIDITY SCORE (0-25)
  // Spread basso + liquidità bid = buone condizioni
  const spreadScore   = Math.max(0, 25 - (book.spreadPct * 20));
  const bidLiqScore   = Math.min(25, (book.bidLiq1pct / 1_000_000) * 5);
  const liquidityScore = (spreadScore + bidLiqScore) / 2;

  // 2. MOMENTUM SCORE (0-25)
  // Buy pressure + prezzo sopra VWAP
  const pressureScore = (trades.buyPressure / 100) * 15;
  const vwapDist      = ticker.last > ticker.vwap24h
    ? Math.min(10, ((ticker.last - ticker.vwap24h) / ticker.vwap24h) * 1000)
    : 0;
  const momentumScore = pressureScore + vwapDist;

  // 3. RISK SCORE inverted (0-25)
  // Presenza di ask walls vicine = rischio alto = score basso
  const nearWalls = book.askWalls?.filter(
    w => w.price < ticker.last * 1.02
  ).length || 0;
  const riskScore = Math.max(0, 25 - (nearWalls * 8));

  // 4. WHALE SCORE (0-25)
  // Whale che comprano = bullish
  const whaleBuys  = trades.whaleTrades?.filter(t => t.side === "BUY").length  || 0;
  const whaleSells = trades.whaleTrades?.filter(t => t.side === "SELL").length || 0;
  const whaleScore = Math.min(25, Math.max(0, (whaleBuys - whaleSells) * 5 + 12));

  const total = liquidityScore + momentumScore + riskScore + whaleScore;

  return {
    total:     Math.round(Math.min(100, Math.max(0, total))),
    liquidity: Math.round(liquidityScore),
    momentum:  Math.round(momentumScore),
    risk:      Math.round(riskScore),
    whale:     Math.round(whaleScore),
  };
}

// ─── DECISION ENGINE ─────────────────────────────────────────────────────────

export function decide(packIndex, ticker, book, trades, paperStatus) {
  const score     = packIndex.total;
  const hasDog    = paperStatus?.balances?.DOG?.total > 0;
  const dogBalance = paperStatus?.balances?.DOG?.total || 0;
  const usdBalance = paperStatus?.balances?.USD?.available || 0;

  let decision, reason, action;

  // RISK_OFF — condizioni pericolose
  if (book.spreadPct > 1.0) {
    decision = DECISIONS.RISK_OFF;
    reason   = `Spread anomalo (${book.spreadPct}%) — mercato illiquido`;
    action   = "Stay out";
  }
  // WATCH_BUY — condizioni favorevoli all'acquisto
  else if (score >= 65 && !hasDog && usdBalance >= TRADE_SIZE_USD) {
    decision = DECISIONS.WATCH_BUY;
    reason   = `Pack Index ${score}/100 — Buy pressure ${trades.buyPressure}% — Condizioni favorevoli`;
    action   = `Paper buy ~${Math.floor(TRADE_SIZE_USD / ticker.last)} DOG`;
  }
  // WATCH_SELL — condizioni favorevoli alla vendita
  else if (score <= 35 && hasDog) {
    decision = DECISIONS.WATCH_SELL;
    reason   = `Pack Index ${score}/100 — Sell pressure ${100 - trades.buyPressure}% — Segnale di uscita`;
    action   = `Paper sell ${Math.floor(dogBalance)} DOG`;
  }
  // HOLD — nessun segnale forte
  else {
    decision = DECISIONS.HOLD;
    reason   = `Pack Index ${score}/100 — Nessun segnale forte`;
    action   = hasDog ? "Hold position" : "Wait for entry";
  }

  return { decision, reason, action, score, hasDog, dogBalance, usdBalance };
}
