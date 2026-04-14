import { appendCsvRow } from "../utils.js";

const TRADE_LOG_PATH = "./logs/trades.csv";

const TRADE_HEADER = [
  "timestamp_entry",
  "market_slug",
  "side",            // UP | DOWN
  "phase",           // EARLY | MID | LATE
  "strength",        // STRONG | GOOD | OPTIONAL
  "entry_price_cents",
  "shares",
  "cost_usd",
  "payout_if_win",
  "edge_pct",
  "model_prob",
  "btc_price_at_entry",
  "price_to_beat",
  "time_left_min",
  "settlement_time",
  "exit_price_cents",
  "result",          // WIN | LOSE | PENDING | CANCELLED
  "pnl_usd"
];

// In-memory pending trades: keyed by market_slug
const pendingTrades = new Map();

/**
 * Register a new valid entry.
 * Called when rec.action === "ENTER"
 */
export function recordEntry({
  marketSlug,
  settlementMs,
  side,
  phase,
  strength,
  entryPriceCents,
  modelProb,
  edgeUp,
  edgeDown,
  btcPrice,
  priceToBeat,
  timeLeftMin,
  costUsd = 1.0
}) {
  if (!marketSlug || !entryPriceCents) return;

  // Avoid duplicate entries for the same market
  if (pendingTrades.has(marketSlug)) return;

  const entryDecimal = entryPriceCents / 100;
  const shares = costUsd / entryDecimal;
  const payoutIfWin = shares - costUsd;
  const edgePct = side === "UP" ? edgeUp : edgeDown;

  const trade = {
    timestamp_entry: new Date().toISOString(),
    market_slug: marketSlug,
    side,
    phase,
    strength,
    entry_price_cents: entryPriceCents,
    shares: +shares.toFixed(4),
    cost_usd: costUsd,
    payout_if_win: +payoutIfWin.toFixed(4),
    edge_pct: edgePct !== null ? +(edgePct * 100).toFixed(2) : null,
    model_prob: modelProb !== null ? +(modelProb * 100).toFixed(2) : null,
    btc_price_at_entry: btcPrice,
    price_to_beat: priceToBeat,
    time_left_min: +timeLeftMin.toFixed(3),
    settlement_time: settlementMs ? new Date(settlementMs).toISOString() : null,
    exit_price_cents: null,
    result: "PENDING",
    pnl_usd: null
  };

  pendingTrades.set(marketSlug, trade);
  _flushTrade(trade);

  console.log(`[TRADE] ENTRY recorded: ${side} @ ${entryPriceCents}¢ | slug: ${marketSlug}`);
}

/**
 * Resolve a pending trade when market settles.
 * winnerSide: "UP" | "DOWN"
 * exitPriceCents: final market price (optional, for reference)
 */
export function resolveTrade({ marketSlug, winnerSide, exitPriceCents = null }) {
  const trade = pendingTrades.get(marketSlug);
  if (!trade || trade.result !== "PENDING") return;

  const isWin = trade.side === winnerSide;
  trade.exit_price_cents = exitPriceCents;
  trade.result = isWin ? "WIN" : "LOSE";
  trade.pnl_usd = isWin
    ? +trade.payout_if_win.toFixed(4)
    : +(-trade.cost_usd).toFixed(4);

  _appendResolvedTrade(trade);
  pendingTrades.delete(marketSlug);

  console.log(`[TRADE] RESOLVED: ${trade.side} @ ${trade.entry_price_cents}¢ → ${trade.result} | PnL: ${trade.pnl_usd >= 0 ? "+" : ""}${trade.pnl_usd}`);
}

/**
 * Cancel a pending trade (market changed / data lost).
 */
export function cancelPendingTrade(marketSlug) {
  const trade = pendingTrades.get(marketSlug);
  if (!trade || trade.result !== "PENDING") return;

  trade.result = "CANCELLED";
  trade.pnl_usd = 0;
  _appendResolvedTrade(trade);
  pendingTrades.delete(marketSlug);
}

/**
 * Try to auto-resolve a pending trade by comparing final BTC price vs price_to_beat.
 * Called every loop iteration when settlement time has passed.
 */
export function tryAutoResolve({ marketSlug, currentBtcPrice, settlementMs }) {
  const trade = pendingTrades.get(marketSlug);
  if (!trade || trade.result !== "PENDING") return;
  if (!settlementMs || Date.now() < settlementMs) return;
  if (currentBtcPrice === null || trade.price_to_beat === null) return;

  const actuallyUp = currentBtcPrice >= trade.price_to_beat;
  const winnerSide = actuallyUp ? "UP" : "DOWN";

  resolveTrade({
    marketSlug,
    winnerSide,
    exitPriceCents: null
  });
}

export function getPendingTrades() {
  return [...pendingTrades.values()];
}

export function hasPendingTrade(marketSlug) {
  return pendingTrades.has(marketSlug);
}

// Write initial row as PENDING
function _flushTrade(trade) {
  appendCsvRow(TRADE_LOG_PATH, TRADE_HEADER, _tradeToRow(trade));
}

// Append updated row after resolution
function _appendResolvedTrade(trade) {
  appendCsvRow(TRADE_LOG_PATH, TRADE_HEADER, _tradeToRow(trade));
}

function _tradeToRow(t) {
  return [
    t.timestamp_entry,
    t.market_slug,
    t.side,
    t.phase,
    t.strength,
    t.entry_price_cents,
    t.shares,
    t.cost_usd,
    t.payout_if_win,
    t.edge_pct,
    t.model_prob,
    t.btc_price_at_entry,
    t.price_to_beat,
    t.time_left_min,
    t.settlement_time,
    t.exit_price_cents ?? "",
    t.result,
    t.pnl_usd ?? ""
  ];
}