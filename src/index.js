import "dotenv/config";
import { CONFIG } from "./config.js";
import { fetchKlines, fetchLastPrice } from "./data/binance.js";
import { fetchChainlinkBtcUsd } from "./data/chainlink.js";
import { startChainlinkPriceStream } from "./data/chainlinkWs.js";
import { startPolymarketChainlinkPriceStream } from "./data/polymarketLiveWs.js";
import { polymarketDecisionEngine } from "./engines/polymarketSkill.js";
import {
  fetchMarketBySlug,
  fetchLiveEventsBySeriesId,
  flattenEventMarkets,
  pickLatestLiveMarket,
  fetchClobPrice,
  fetchOrderBook,
  summarizeOrderBook
} from "./data/polymarket.js";
import { localAdvisor, formatAdvisorLine } from "./engines/localAdvisor.js";
import { computeSessionVwap, computeVwapSeries } from "./indicators/vwap.js";
import { computeRsi, sma, slopeLast } from "./indicators/rsi.js";
import { computeMacd } from "./indicators/macd.js";
import { computeHeikenAshi, countConsecutive } from "./indicators/heikenAshi.js";
import { detectRegime } from "./engines/regime.js";
import { scoreDirection, applyTimeAwareness } from "./engines/probability.js";
import { computeEdge, decide } from "./engines/edge.js";
import { appendCsvRow, formatNumber, formatPct, getCandleWindowTiming, sleep } from "./utils.js";
import { createTradeJournal } from "./tradeJournal.js";
import { startBinanceTradeStream } from "./data/binanceWs.js";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { applyGlobalProxyFromEnv } from "./net/proxy.js";
import { updateLearning } from "./engines/autoLearning.js";
import { learningState } from "./engines/learningState.js";

const CANDLE_CACHE_FILE_5M = "./logs/klines_5m.json";
const CANDLE_CACHE_LIMIT_5M = 100;

function loadLocalKlines(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data
      .filter((c) => c && Number.isFinite(c.openTime) && Number.isFinite(c.closeTime))
      .map((c) => ({
        openTime: Number(c.openTime),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume),
        closeTime: Number(c.closeTime)
      }));
  } catch {
    return [];
  }
}

function saveLocalKlines(filePath, klines) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(klines, null, 2), "utf8");
  } catch {
    // ignore
  }
}

function mergeKlines(base, incoming, limit) {
  const map = new Map();
  for (const c of base || []) {
    if (!c || !Number.isFinite(c.openTime)) continue;
    map.set(c.openTime, c);
  }
  for (const c of incoming || []) {
    if (!c || !Number.isFinite(c.openTime)) continue;
    map.set(c.openTime, c);
  }
  const merged = Array.from(map.values())
    .sort((a, b) => a.openTime - b.openTime);
  return merged.slice(-limit);
}

function countVwapCrosses(closes, vwapSeries, lookback) {
  if (closes.length < lookback || vwapSeries.length < lookback) return null;
  let crosses = 0;
  for (let i = closes.length - lookback + 1; i < closes.length; i += 1) {
    const prev = closes[i - 1] - vwapSeries[i - 1];
    const cur = closes[i] - vwapSeries[i];
    if (prev === 0) continue;
    if ((prev > 0 && cur < 0) || (prev < 0 && cur > 0)) crosses += 1;
  }
  return crosses;
}

applyGlobalProxyFromEnv();

function fmtTimeLeft(mins) {
  const totalSeconds = Math.max(0, Math.floor(mins * 60));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ANSI = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  lightRed: "\x1b[91m",
  gray: "\x1b[90m",
  white: "\x1b[97m",
  dim: "\x1b[2m"
};

function screenWidth() {
  const w = Number(process.stdout?.columns);
  return Number.isFinite(w) && w >= 40 ? w : 80;
}

function sepLine(ch = "─") {
  const w = screenWidth();
  return `${ANSI.white}${ch.repeat(w)}${ANSI.reset}`;
}

function renderScreen(text) {
  try {
    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);
  } catch {
    // ignore
  }
  process.stdout.write(text);
}

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

function padLabel(label, width) {
  const visible = stripAnsi(label).length;
  if (visible >= width) return label;
  return label + " ".repeat(width - visible);
}

function centerText(text, width) {
  const visible = stripAnsi(text).length;
  if (visible >= width) return text;
  const left = Math.floor((width - visible) / 2);
  const right = width - visible - left;
  return " ".repeat(left) + text + " ".repeat(right);
}

const LABEL_W = 16;
function kv(label, value) {
  const l = padLabel(String(label), LABEL_W);
  return `${l}${value}`;
}

function section(title) {
  return `${ANSI.white}${title}${ANSI.reset}`;
}

function colorPriceLine({ label, price, prevPrice, decimals = 0, prefix = "" }) {
  if (price === null || price === undefined) {
    return `${label}: ${ANSI.gray}-${ANSI.reset}`;
  }

  const p = Number(price);
  const prev = prevPrice === null || prevPrice === undefined ? null : Number(prevPrice);

  let color = ANSI.reset;
  let arrow = "";
  if (prev !== null && Number.isFinite(prev) && Number.isFinite(p) && p !== prev) {
    if (p > prev) {
      color = ANSI.green;
      arrow = " ↑";
    } else {
      color = ANSI.red;
      arrow = " ↓";
    }
  }

  const formatted = `${prefix}${formatNumber(p, decimals)}`;
  return `${label}: ${color}${formatted}${arrow}${ANSI.reset}`;
}

function formatSignedDelta(delta, base) {
  if (delta === null || base === null || base === 0) return `${ANSI.gray}-${ANSI.reset}`;
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
  const pct = (Math.abs(delta) / Math.abs(base)) * 100;
  return `${sign}$${Math.abs(delta).toFixed(2)}, ${sign}${pct.toFixed(2)}%`;
}

function colorByNarrative(text, narrative) {
  if (narrative === "LONG") return `${ANSI.green}${text}${ANSI.reset}`;
  if (narrative === "SHORT") return `${ANSI.red}${text}${ANSI.reset}`;
  return `${ANSI.gray}${text}${ANSI.reset}`;
}

function formatNarrativeValue(label, value, narrative) {
  return `${label}: ${colorByNarrative(value, narrative)}`;
}

function narrativeFromSign(x) {
  if (x === null || x === undefined || !Number.isFinite(Number(x)) || Number(x) === 0) return "NEUTRAL";
  return Number(x) > 0 ? "LONG" : "SHORT";
}

function narrativeFromRsi(rsi) {
  if (rsi === null || rsi === undefined || !Number.isFinite(Number(rsi))) return "NEUTRAL";
  const v = Number(rsi);
  if (v >= 55) return "LONG";
  if (v <= 45) return "SHORT";
  return "NEUTRAL";
}

function narrativeFromSlope(slope) {
  if (slope === null || slope === undefined || !Number.isFinite(Number(slope)) || Number(slope) === 0) return "NEUTRAL";
  return Number(slope) > 0 ? "LONG" : "SHORT";
}

function formatProbPct(p, digits = 0) {
  if (p === null || p === undefined || !Number.isFinite(Number(p))) return "-";
  return `${(Number(p) * 100).toFixed(digits)}%`;
}

function fmtEtTime(now = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(now);
  } catch {
    return "-";
  }
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatWindowLabel(startMs, endMs) {
  const start = new Date(startMs);
  const end = new Date(endMs);
  return `${pad2(start.getHours())}:${pad2(start.getMinutes())} a ${pad2(end.getHours())}:${pad2(end.getMinutes())}`;
}

function pickClosePrice(candles, targetMs) {
  if (!Array.isArray(candles) || !candles.length) return null;
  for (let i = candles.length - 1; i >= 0; i -= 1) {
    const c = candles[i];
    if (!c || !Number.isFinite(c.closeTime)) continue;
    if (c.closeTime <= targetMs) return Number.isFinite(c.close) ? c.close : null;
  }
  return null;
}

function getBtcSession(now = new Date()) {
  const h = now.getUTCHours();
  const inAsia = h >= 0 && h < 8;
  const inEurope = h >= 7 && h < 16;
  const inUs = h >= 13 && h < 22;

  if (inEurope && inUs) return "Europe/US overlap";
  if (inAsia && inEurope) return "Asia/Europe overlap";
  if (inAsia) return "Asia";
  if (inEurope) return "Europe";
  if (inUs) return "US";
  return "Off-hours";
}

function parsePriceToBeat(market) {
  const text = String(market?.question ?? market?.title ?? "");
  if (!text) return null;
  const m = text.match(/price\s*to\s*beat[^\d$]*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  if (!m) return null;
  const raw = m[1].replace(/,/g, "");
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

const dumpedMarkets = new Set();

function safeFileSlug(x) {
  return String(x ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 120);
}

function extractNumericFromMarket(market) {
  const directKeys = [
    "priceToBeat",
    "price_to_beat",
    "strikePrice",
    "strike_price",
    "strike",
    "threshold",
    "thresholdPrice",
    "threshold_price",
    "targetPrice",
    "target_price",
    "referencePrice",
    "reference_price"
  ];

  for (const k of directKeys) {
    const v = market?.[k];
    const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
    if (Number.isFinite(n)) return n;
  }

  const seen = new Set();
  const stack = [{ obj: market, depth: 0 }];

  while (stack.length) {
    const { obj, depth } = stack.pop();
    if (!obj || typeof obj !== "object") continue;
    if (seen.has(obj) || depth > 6) continue;
    seen.add(obj);

    const entries = Array.isArray(obj) ? obj.entries() : Object.entries(obj);
    for (const [key, value] of entries) {
      const k = String(key).toLowerCase();
      if (value && typeof value === "object") {
        stack.push({ obj: value, depth: depth + 1 });
        continue;
      }

      if (!/(price|strike|threshold|target|beat)/i.test(k)) continue;

      const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
      if (!Number.isFinite(n)) continue;

      if (n > 1000 && n < 2_000_000) return n;
    }
  }

  return null;
}

function priceToBeatFromPolymarketMarket(market) {
  const n = extractNumericFromMarket(market);
  if (n !== null) return n;
  return parsePriceToBeat(market);
}

const marketCache = {
  market: null,
  fetchedAtMs: 0
};

async function resolveCurrentBtc15mMarket() {
  if (CONFIG.polymarket.marketSlug) {
    return await fetchMarketBySlug(CONFIG.polymarket.marketSlug);
  }

  if (!CONFIG.polymarket.autoSelectLatest) return null;

  const now = Date.now();
  if (marketCache.market && now - marketCache.fetchedAtMs < CONFIG.pollIntervalMs) {
    return marketCache.market;
  }

  const events = await fetchLiveEventsBySeriesId({ seriesId: CONFIG.polymarket.seriesId, limit: 25 });
  const markets = flattenEventMarkets(events);
  const picked = pickLatestLiveMarket(markets);

  marketCache.market = picked;
  marketCache.fetchedAtMs = now;
  return picked;
}

async function fetchPolymarketSnapshot() {
  const market = await resolveCurrentBtc15mMarket();

  if (!market) return { ok: false, reason: "market_not_found" };

  const outcomes = Array.isArray(market.outcomes) ? market.outcomes : (typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : []);
  const outcomePrices = Array.isArray(market.outcomePrices)
    ? market.outcomePrices
    : (typeof market.outcomePrices === "string" ? JSON.parse(market.outcomePrices) : []);

  const clobTokenIds = Array.isArray(market.clobTokenIds)
    ? market.clobTokenIds
    : (typeof market.clobTokenIds === "string" ? JSON.parse(market.clobTokenIds) : []);

  let upTokenId = null;
  let downTokenId = null;
  for (let i = 0; i < outcomes.length; i += 1) {
    const label = String(outcomes[i]);
    const tokenId = clobTokenIds[i] ? String(clobTokenIds[i]) : null;
    if (!tokenId) continue;

    if (label.toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase()) upTokenId = tokenId;
    if (label.toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase()) downTokenId = tokenId;
  }

  const upIndex = outcomes.findIndex((x) => String(x).toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase());
  const downIndex = outcomes.findIndex((x) => String(x).toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase());

  const gammaYes = upIndex >= 0 ? Number(outcomePrices[upIndex]) : null;
  const gammaNo = downIndex >= 0 ? Number(outcomePrices[downIndex]) : null;

  if (!upTokenId || !downTokenId) {
    return {
      ok: false,
      reason: "missing_token_ids",
      market,
      outcomes,
      clobTokenIds,
      outcomePrices
    };
  }

  let upBuy = null;
  let downBuy = null;
  let upBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };
  let downBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };

  try {
    const [yesBuy, noBuy, upBook, downBook] = await Promise.all([
      fetchClobPrice({ tokenId: upTokenId, side: "buy" }),
      fetchClobPrice({ tokenId: downTokenId, side: "buy" }),
      fetchOrderBook({ tokenId: upTokenId }),
      fetchOrderBook({ tokenId: downTokenId })
    ]);

    upBuy = yesBuy;
    downBuy = noBuy;
    upBookSummary = summarizeOrderBook(upBook);
    downBookSummary = summarizeOrderBook(downBook);
  } catch {
    upBuy = null;
    downBuy = null;
    upBookSummary = {
      bestBid: Number(market.bestBid) || null,
      bestAsk: Number(market.bestAsk) || null,
      spread: Number(market.spread) || null,
      bidLiquidity: null,
      askLiquidity: null
    };
    downBookSummary = {
      bestBid: null,
      bestAsk: null,
      spread: Number(market.spread) || null,
      bidLiquidity: null,
      askLiquidity: null
    };
  }

  return {
    ok: true,
    market,
    tokens: { upTokenId, downTokenId },
    prices: {
      up: upBuy ?? gammaYes,
      down: downBuy ?? gammaNo
    },
    orderbook: {
      up: upBookSummary,
      down: downBookSummary
    }
  };
}

async function main() {
  const binanceStream = startBinanceTradeStream({ symbol: CONFIG.symbol });
  const polymarketLiveStream = startPolymarketChainlinkPriceStream({});
  const chainlinkStream = startChainlinkPriceStream({});

  const tradeJournal = createTradeJournal({});

  let localKlines5m = loadLocalKlines(CANDLE_CACHE_FILE_5M);

  let prevSpotPrice = null;
  let prevCurrentPrice = null;
  let priceToBeatState = { slug: null, value: null, setAtMs: null };
  let lastWindowStartMs = null;
  let lastEntry = null;
  let lastEntryWindowEndMs = null;
  const pendingSignals = new Map();

  const header = [
    "timestamp",
    "entry_minute",
    "time_left_min",
    "regime",
    "signal",
    "model_up",
    "model_down",
    "mkt_up",
    "mkt_down",
    "edge_up",
    "edge_down",
    "recommendation",
    "final_price",
    "final_result"
  ];

  while (true) {
    const timing = getCandleWindowTiming(CONFIG.candleWindowMinutes);

    const wsTick = binanceStream.getLast();
    const wsPrice = wsTick?.price ?? null;

    const polymarketWsTick = polymarketLiveStream.getLast();
    const polymarketWsPrice = polymarketWsTick?.price ?? null;

    const chainlinkWsTick = chainlinkStream.getLast();
    const chainlinkWsPrice = chainlinkWsTick?.price ?? null;

    try {
      const chainlinkPromise = polymarketWsPrice !== null
        ? Promise.resolve({ price: polymarketWsPrice, updatedAt: polymarketWsTick?.updatedAt ?? null, source: "polymarket_ws" })
        : chainlinkWsPrice !== null
          ? Promise.resolve({ price: chainlinkWsPrice, updatedAt: chainlinkWsTick?.updatedAt ?? null, source: "chainlink_ws" })
          : fetchChainlinkBtcUsd();

      const [klines5m, lastPrice, chainlink, poly] = await Promise.all([
        fetchKlines({ interval: "5m", limit: 200 }),
        fetchLastPrice(),
        chainlinkPromise,
        fetchPolymarketSnapshot()
      ]);

      const merged5m = mergeKlines(localKlines5m, klines5m, CANDLE_CACHE_LIMIT_5M);
      if (merged5m.length) {
        localKlines5m = merged5m;
        saveLocalKlines(CANDLE_CACHE_FILE_5M, localKlines5m);
      }

      const settlementMs = poly.ok && poly.market?.endDate ? new Date(poly.market.endDate).getTime() : null;
      const settlementLeftMin = settlementMs ? (settlementMs - Date.now()) / 60_000 : null;

      const timeLeftMin = settlementLeftMin ?? timing.remainingMinutes;

      const candles = localKlines5m.length ? localKlines5m : klines5m;
      const closes = candles.map((c) => c.close);

      const vwap = computeSessionVwap(candles);
      const vwapSeries = computeVwapSeries(candles);
      const vwapNow = vwapSeries[vwapSeries.length - 1];

      const lookback = CONFIG.vwapSlopeLookbackMinutes;
      const vwapSlope = vwapSeries.length >= lookback ? (vwapNow - vwapSeries[vwapSeries.length - lookback]) / lookback : null;
      const vwapDist = vwapNow ? (lastPrice - vwapNow) / vwapNow : null;

      const rsiNow = computeRsi(closes, CONFIG.rsiPeriod);
      const rsiSeries = [];
      for (let i = 0; i < closes.length; i += 1) {
        const sub = closes.slice(0, i + 1);
        const r = computeRsi(sub, CONFIG.rsiPeriod);
        if (r !== null) rsiSeries.push(r);
      }
      const rsiMa = sma(rsiSeries, CONFIG.rsiMaPeriod);
      const rsiSlope = slopeLast(rsiSeries, 3);

      const macd = computeMacd(closes, CONFIG.macdFast, CONFIG.macdSlow, CONFIG.macdSignal);

      const ha = computeHeikenAshi(candles);
      const consec = countConsecutive(ha);

      const ha5m    = computeHeikenAshi(klines5m);
      const consec5m = countConsecutive(ha5m);

      const vwapCrossCount = countVwapCrosses(closes, vwapSeries, 20);
      const volumeRecent = candles.slice(-20).reduce((a, c) => a + c.volume, 0);
      const volumeAvg = candles.slice(-120).reduce((a, c) => a + c.volume, 0) / 6;

      const failedVwapReclaim = vwapNow !== null && vwapSeries.length >= 3
        ? closes[closes.length - 1] < vwapNow && closes[closes.length - 2] > vwapSeries[vwapSeries.length - 2]
        : false;

      const regimeInfo = detectRegime({
        price: lastPrice,
        vwap: vwapNow,
        vwapSlope,
        vwapCrossCount,
        volumeRecent,
        volumeAvg
      });

      const scored = scoreDirection({
        price:            lastPrice,
        vwap:             vwapNow,
        vwapSlope,
        rsi:              rsiNow,
        rsiSlope,
        macd,
        heikenColor:      consec.color,
        heikenCount:      consec.count,
        heikenColor5m:    consec5m.color,     // NOVO: confirmação 5m
        heikenCount5m:    consec5m.count,     // NOVO
        failedVwapReclaim,
        priceToBeat:      priceToBeatState.value,  // NOVO: fator chave
        volume20:         volumeRecent,        // já calculado mais acima
        volumeAvg,                             // já calculado mais acima
        regime:           regimeInfo.regime    // NOVO: regime-aware
      });

      const timeAware = applyTimeAwareness(scored.rawUp, timeLeftMin, CONFIG.candleWindowMinutes);

      const marketUp = poly.ok ? poly.prices.up : null;
      const marketDown = poly.ok ? poly.prices.down : null;
      const edge = computeEdge({ modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown, marketYes: marketUp, marketNo: marketDown });

      const currentPrice = chainlink?.price ?? null;

      // Esse é a SKILL
      // const rec = decide({
      //   remainingMinutes: timeLeftMin,
      //   edgeUp:           edge.edgeUp,
      //   edgeDown:         edge.edgeDown,
      //   modelUp:          timeAware.adjustedUp,
      //   modelDown:        timeAware.adjustedDown,
      //   score:            scored.score,        // NOVO: score de confluência
      //   bullCount:        scored.bullCount,    // NOVO
      //   bearCount:        scored.bearCount,    // NOVO
      //   totalSignals:     scored.totalSignals, // NOVO
      //   regime:           regimeInfo.regime    // NOVO
      // });

      const rec = polymarketDecisionEngine({
        timeLeftMin,
        score: scored.score,
        bullCount: scored.bullCount,
        bearCount: scored.bearCount,
        marketUp,
        marketDown,
        modelUp: timeAware.adjustedUp,
        modelDown: timeAware.adjustedDown,
        currentPrice,
        priceToBeat: priceToBeatState.value
      });

      const vwapSlopeLabel = vwapSlope === null ? "-" : vwapSlope > 0 ? "UP" : vwapSlope < 0 ? "DOWN" : "FLAT";

      const macdLabel = macd === null
        ? "-"
        : macd.hist < 0
          ? (macd.histDelta !== null && macd.histDelta < 0 ? "bearish (expanding)" : "bearish")
          : (macd.histDelta !== null && macd.histDelta > 0 ? "bullish (expanding)" : "bullish");

      const lastCandle = candles.length ? candles[candles.length - 1] : null;
      const lastClose = lastCandle?.close ?? null;
      const close5mAgo = candles.length >= 2 ? candles[candles.length - 2]?.close ?? null : null;
      const close15mAgo = candles.length >= 4 ? candles[candles.length - 4]?.close ?? null : null;
      const delta5m = lastClose !== null && close5mAgo !== null ? lastClose - close5mAgo : null;
      const delta15m = lastClose !== null && close15mAgo !== null ? lastClose - close15mAgo : null;

      const haNarrative = (consec.color ?? "").toLowerCase() === "green" ? "LONG" : (consec.color ?? "").toLowerCase() === "red" ? "SHORT" : "NEUTRAL";
      const rsiNarrative = narrativeFromSlope(rsiSlope);
      const macdNarrative = narrativeFromSign(macd?.hist ?? null);
      const vwapNarrative = narrativeFromSign(vwapDist);

      const pLong = timeAware?.adjustedUp ?? null;
      const pShort = timeAware?.adjustedDown ?? null;
      const predictNarrative = (pLong !== null && pShort !== null && Number.isFinite(pLong) && Number.isFinite(pShort))
        ? (pLong > pShort ? "LONG" : pShort > pLong ? "SHORT" : "NEUTRAL")
        : "NEUTRAL";
      const predictValue = `${ANSI.green}LONG${ANSI.reset} ${ANSI.green}${formatProbPct(pLong, 0)}${ANSI.reset} / ${ANSI.red}SHORT${ANSI.reset} ${ANSI.red}${formatProbPct(pShort, 0)}${ANSI.reset}`;
      const predictLine = `Predict: ${predictValue}`;

      const marketUpStr = `${marketUp ?? "-"}${marketUp === null || marketUp === undefined ? "" : "¢"}`;
      const marketDownStr = `${marketDown ?? "-"}${marketDown === null || marketDown === undefined ? "" : "¢"}`;
      const polyHeaderValue = `${ANSI.green}↑ UP${ANSI.reset} ${marketUpStr}  |  ${ANSI.red}↓ DOWN${ANSI.reset} ${marketDownStr}`;

      const heikenValue = `${consec.color ?? "-"} x${consec.count}`;
      const heikenLine = formatNarrativeValue("Heiken Ashi", heikenValue, haNarrative);

      const rsiArrow = rsiSlope !== null && rsiSlope < 0 ? "↓" : rsiSlope !== null && rsiSlope > 0 ? "↑" : "-";
      const rsiValue = `${formatNumber(rsiNow, 1)} ${rsiArrow}`;
      const rsiLine = formatNarrativeValue("RSI", rsiValue, rsiNarrative);

      const macdLine = formatNarrativeValue("MACD", macdLabel, macdNarrative);

      const delta5Narrative = narrativeFromSign(delta5m);
      const delta15Narrative = narrativeFromSign(delta15m);
      const deltaValue = `${colorByNarrative(formatSignedDelta(delta5m, lastClose), delta5Narrative)} | ${colorByNarrative(formatSignedDelta(delta15m, lastClose), delta15Narrative)}`;
      const deltaLine = `Delta 5/15Min: ${deltaValue}`;

      const vwapValue = `${formatNumber(vwapNow, 0)} (${formatPct(vwapDist, 2)}) | slope: ${vwapSlopeLabel}`;
      const vwapLine = formatNarrativeValue("VWAP", vwapValue, vwapNarrative);

      const indicatorSignals = [
        { name: "heiken", narrative: haNarrative, weight: 1.0 },
        { name: "rsi", narrative: rsiNarrative, weight: 1.0 },
        { name: "macd", narrative: macdNarrative, weight: 1.0 },
        { name: "vwap", narrative: vwapNarrative, weight: 1.0 },
        { name: "delta5", narrative: delta5Narrative, weight: 0.5 },
        { name: "delta15", narrative: delta15Narrative, weight: 0.5 }
      ];

      let indicatorScore = 0;
      let indicatorWeight = 0;
      for (const s of indicatorSignals) {
        const v = s.narrative === "LONG" ? 1 : s.narrative === "SHORT" ? -1 : 0;
        indicatorScore += v * s.weight;
        indicatorWeight += s.weight;
      }

      const modelScore = (pLong !== null && pShort !== null && Number.isFinite(pLong) && Number.isFinite(pShort))
        ? (pLong - pShort)
        : 0;

      const combinedScoreRaw = (modelScore * 2) + (indicatorWeight ? (indicatorScore / indicatorWeight) : 0);
      const combinedScore = Math.max(-1, Math.min(1, combinedScoreRaw));
      const biasNarrative = combinedScore > 0.15 ? "LONG" : combinedScore < -0.15 ? "SHORT" : "NEUTRAL";
      const biasText = biasNarrative === "LONG"
        ? `${ANSI.green}LONG${ANSI.reset}`
        : biasNarrative === "SHORT"
          ? `${ANSI.red}SHORT${ANSI.reset}`
          : `${ANSI.gray}NEUTRAL${ANSI.reset}`;
      const biasScoreText = `${combinedScore >= 0 ? "+" : ""}${combinedScore.toFixed(2)}`;
      const biasLine = `${biasText} (${biasScoreText})`;
      const biasActionText = biasNarrative === "LONG"
        ? `${ANSI.green}COMPRAR${ANSI.reset}`
        : biasNarrative === "SHORT"
          ? `${ANSI.red}VENDER${ANSI.reset}`
          : `${ANSI.gray}NEUTRO${ANSI.reset}`;

      const signal = rec.action === "ENTER"
        ? (rec.side === "UP" ? "BUY UP" : "BUY DOWN")
        : "NO TRADE";

      const actionLine = rec.action === "ENTER"
        ? `${rec.action} NOW (${rec.phase} ENTRY)`
        : `NO TRADE (${rec.phase})`;
      const recommendationText = rec.action === "ENTER"
        ? `${ANSI.green}TRADE REALIZADO${ANSI.reset}`
        : `${ANSI.gray}SEM TRADE${ANSI.reset}`;

      const liveEntryStatus = (() => {
        if (!lastEntry) return null;
        const currentTokenPrice = lastEntry.side === "UP"
          ? (poly.ok ? poly.prices.up : null)
          : (poly.ok ? poly.prices.down : null);
        if (!Number.isFinite(currentTokenPrice) || !Number.isFinite(lastEntry.entryPrice)) return null;
        const delta = currentTokenPrice - lastEntry.entryPrice;
        const isWin = delta >= 0;
        const color = isWin ? ANSI.green : ANSI.red;
        const label = isWin ? "GANHANDO" : "PERDENDO";
        const cents = (Math.abs(delta) * 100).toFixed(2);
        return `${color}${label} ${cents}¢${ANSI.reset}`;
      })();

      const spreadUp = poly.ok ? poly.orderbook.up.spread : null;
      const spreadDown = poly.ok ? poly.orderbook.down.spread : null;

      const spread = spreadUp !== null && spreadDown !== null ? Math.max(spreadUp, spreadDown) : (spreadUp ?? spreadDown);
      const liquidity = poly.ok
        ? (Number(poly.market?.liquidityNum) || Number(poly.market?.liquidity) || null)
        : null;

      const spotPrice = wsPrice ?? lastPrice;
      
      const marketSlug = poly.ok ? String(poly.market?.slug ?? "") : "";
      const marketStartMs = poly.ok && poly.market?.eventStartTime ? new Date(poly.market.eventStartTime).getTime() : null;

      if (lastWindowStartMs !== null && timing.startMs !== lastWindowStartMs) {
        tradeJournal.closeWindow({
          windowEndMs: timing.startMs,
          candles,
          fallbackPrice: currentPrice ?? spotPrice,
          outcomePrices: {
            up: poly.ok ? poly.prices.up : null,
            down: poly.ok ? poly.prices.down : null
          }
        });
        tradeJournal.maybeSuggestParams();
        lastEntry = null;

        const pendings = pendingSignals.get(timing.endMs);

        if (pendings && pendings.length) {
          for (const pending of pendings) {
            const btcClose = pickClosePrice(candles, timing.startMs) ?? (Number.isFinite(currentPrice) ? currentPrice : spotPrice);
            const strike = Number.isFinite(pending.strikeAtOpen) ? pending.strikeAtOpen : null;

            let result = "";

            if (Number.isFinite(btcClose) && strike !== null) {
              result = pending.side === "UP"
                ? (btcClose > strike ? "GANHO" : "PERDA")
                : (btcClose < strike ? "GANHO" : "PERDA");
            }

            appendCsvRow("./logs/signals.csv", header, [
              pending.timestamp,
              pending.entry_minute,
              pending.time_left_min,
              pending.regime,
              pending.signal,
              pending.model_up,
              pending.model_down,
              pending.mkt_up,
              pending.mkt_down,
              pending.edge_up,
              pending.edge_down,
              pending.recommendation,
              btcClose ?? "",
              result
            ]);

            updateLearning({
              trade: {
                evExpected: pending.edge ?? 0, // 👈 MELHOR que lastEntry
                result: result === "GANHO" ? 1 : -1,
                pnl: result === "GANHO" ? 1 : -1
              }
            });
          }

          pendingSignals.delete(timing.endMs);

          console.log("[AUTO-LEARNING]", {
            edgeMin: learningState.edgeMin,
            deltaLate: learningState.deltaMin.LATE,
            winRate: (learningState.stats.wins / learningState.stats.totalTrades).toFixed(2),
            pnl: learningState.stats.realPnL
          });
        }
      }
      lastWindowStartMs = timing.startMs;

      const candleOpen = lastCandle?.open ?? null;
      const refPriceForOpen = currentPrice ?? spotPrice;
      let openSignalText = `${ANSI.gray}NEUTRO${ANSI.reset}`;
      if (candleOpen !== null && refPriceForOpen !== null && Number.isFinite(candleOpen) && Number.isFinite(refPriceForOpen)) {
        if (refPriceForOpen > candleOpen) {
          openSignalText = `${ANSI.green}COMPRAR (acima da abertura)${ANSI.reset}`;
        } else if (refPriceForOpen < candleOpen) {
          openSignalText = `${ANSI.red}VENDER (abaixo da abertura)${ANSI.reset}`;
        } else {
          openSignalText = `${ANSI.gray}NEUTRO (na abertura)${ANSI.reset}`;
        }
      }

      if (marketSlug && priceToBeatState.slug !== marketSlug) {
        priceToBeatState = { slug: marketSlug, value: null, setAtMs: null };
      }

      if (priceToBeatState.slug && priceToBeatState.value === null && currentPrice !== null) {
        const nowMs = Date.now();
        const okToLatch = marketStartMs === null ? true : nowMs >= marketStartMs;
        if (okToLatch) {
          priceToBeatState = { slug: priceToBeatState.slug, value: Number(currentPrice), setAtMs: nowMs };
        }
      }

      const priceToBeat = priceToBeatState.slug === marketSlug ? priceToBeatState.value : null;
      const currentPriceBaseLine = colorPriceLine({
        label: "CURRENT PRICE",
        price: currentPrice,
        prevPrice: prevCurrentPrice,
        decimals: 2,
        prefix: "$"
      });

      const ptbDelta = (currentPrice !== null && priceToBeat !== null && Number.isFinite(currentPrice) && Number.isFinite(priceToBeat))
        ? currentPrice - priceToBeat
        : null;
      const ptbDeltaColor = ptbDelta === null
        ? ANSI.gray
        : ptbDelta > 0
          ? ANSI.green
          : ptbDelta < 0
            ? ANSI.red
            : ANSI.gray;
      const ptbDeltaText = ptbDelta === null
        ? `${ANSI.gray}-${ANSI.reset}`
        : `${ptbDeltaColor}${ptbDelta > 0 ? "+" : ptbDelta < 0 ? "-" : ""}$${Math.abs(ptbDelta).toFixed(2)}${ANSI.reset}`;
      const currentPriceValue = currentPriceBaseLine.split(": ")[1] ?? currentPriceBaseLine;
      const currentPriceLine = kv("CURRENT PRICE:", `${currentPriceValue} (${ptbDeltaText})`);
      
      const signalSummaryLine = (() => {
        const details = scored.signalDetails ?? [];
        const ups   = details.filter(s => s.direction === "UP").map(s => s.name).join(" ");
        const downs = details.filter(s => s.direction === "DOWN").map(s => s.name).join(" ");
        const scoreText = scored.score >= 0
          ? `${ANSI.green}+${scored.score.toFixed(2)}${ANSI.reset}`
          : `${ANSI.red}${scored.score.toFixed(2)}${ANSI.reset}`;
        return `UP:[${ups || "-"}]  DOWN:[${downs || "-"}]  score:${scoreText}`;
      })();

      if (poly.ok && poly.market && priceToBeatState.value === null) {
        const slug = safeFileSlug(poly.market.slug || poly.market.id || "market");
        if (slug && !dumpedMarkets.has(slug)) {
          dumpedMarkets.add(slug);
          try {
            fs.mkdirSync("./logs", { recursive: true });
            fs.writeFileSync(path.join("./logs", `polymarket_market_${slug}.json`), JSON.stringify(poly.market, null, 2), "utf8");
          } catch {
            // ignore
          }
        }
      }

      const advisor = localAdvisor({
        remainingMinutes: timeLeftMin,
        score:            scored.score,
        bullCount:        scored.bullCount,
        bearCount:        scored.bearCount,
        marketUp:   marketUp,
        marketDown: marketDown,
        modelUp:          timeAware.adjustedUp,
        modelDown:        timeAware.adjustedDown,
        currentPrice,
        priceToBeat:      priceToBeatState.value,
        regime:           regimeInfo.regime,
        spread
      });
      
      const advisorLine = formatAdvisorLine(advisor, ANSI);

      if (rec.action === "ENTER") {
        if (lastEntryWindowEndMs === timing.endMs) {
          
          console.log(`[RE-ENTRY] ${new Date().toISOString()} side=${rec.side} price=${currentPrice ?? spotPrice} phase=${rec.phase} edge=${rec.edge ?? "-"} score=${scored.score} window=${formatWindowLabel(timing.startMs, timing.endMs)} market=${marketSlug || "-"}`);
        } else {
        const entryPrice = rec.side === "UP"
          ? (poly.ok ? poly.prices.up : null)
          : (poly.ok ? poly.prices.down : null);
        const safeEntryPrice = Number.isFinite(entryPrice) ? entryPrice : (currentPrice ?? spotPrice);
        const modelProb = rec.side === "UP" ? timeAware.adjustedUp : timeAware.adjustedDown;
        const signals = rec.side === "UP" ? scored.bullCount : scored.bearCount;
        console.log(`[ENTRY] ${new Date().toISOString()} side=${rec.side} price=${safeEntryPrice} phase=${rec.phase} edge=${rec.edge ?? "-"} score=${scored.score} window=${formatWindowLabel(timing.startMs, timing.endMs)} market=${marketSlug || "-"}`);
        lastEntry = { side: rec.side, entryPrice: safeEntryPrice };
        lastEntryWindowEndMs = timing.endMs;
        tradeJournal.openEntry({
          windowStartMs: timing.startMs,
          windowEndMs: timing.endMs,
          entryPrice: safeEntryPrice,
          strikeAtOpen: priceToBeatState.value,
          side: rec.side,
          edge: rec.edge ?? null,
          modelProb,
          score: scored.score,
          signals,
          phase: rec.phase,
          marketSlug
        });

        if (!pendingSignals.has(timing.endMs)) {
          pendingSignals.set(timing.endMs, []);
        }

        pendingSignals.get(timing.endMs).push({
          timestamp: new Date().toISOString(),
          entry_minute: Number.isFinite(timing.elapsedMinutes) ? timing.elapsedMinutes.toFixed(3) : "",
          time_left_min: Number.isFinite(timeLeftMin) ? timeLeftMin.toFixed(3) : "",
          regime: regimeInfo.regime,
          signal,
          model_up: timeAware.adjustedUp,
          model_down: timeAware.adjustedDown,
          mkt_up: marketUp,
          mkt_down: marketDown,
          edge_up: edge.edgeUp,
          edge_down: edge.edgeDown,
          recommendation: `${rec.side}:${rec.phase}:${rec.strength}`,
          side: rec.side,
          strikeAtOpen: priceToBeatState.value,
          edge: rec.edge
        });
        }
      }

      const binanceSpotBaseLine = colorPriceLine({ label: "BTC (Binance)", price: spotPrice, prevPrice: prevSpotPrice, decimals: 0, prefix: "$" });
      const diffLine = (spotPrice !== null && currentPrice !== null && Number.isFinite(spotPrice) && Number.isFinite(currentPrice) && currentPrice !== 0)
        ? (() => {
          const diffUsd = spotPrice - currentPrice;
          const diffPct = (diffUsd / currentPrice) * 100;
          const sign = diffUsd > 0 ? "+" : diffUsd < 0 ? "-" : "";
          return ` (${sign}$${Math.abs(diffUsd).toFixed(2)}, ${sign}${Math.abs(diffPct).toFixed(2)}%)`;
        })()
        : "";
      const binanceSpotLine = `${binanceSpotBaseLine}${diffLine}`;
      const binanceSpotValue = binanceSpotLine.split(": ")[1] ?? binanceSpotLine;
      const binanceSpotKvLine = kv("BTC (Binance):", binanceSpotValue);

      const titleLine = poly.ok ? `${poly.market?.question ?? "-"}` : "-";
      const marketLine = kv("Mercado:", poly.ok ? (poly.market?.slug ?? "-") : "-");

      const timeColor = timeLeftMin >= 10 && timeLeftMin <= 15
        ? ANSI.green
        : timeLeftMin >= 5 && timeLeftMin < 10
          ? ANSI.yellow
          : timeLeftMin >= 0 && timeLeftMin < 5
            ? ANSI.red
            : ANSI.reset;
      const timeLeftLine = `⏱ Tempo restante: ${timeColor}${fmtTimeLeft(timeLeftMin)}${ANSI.reset}`;

      const entryGateText = `${ANSI.green}LIBERADO (a qualquer momento)${ANSI.reset}`;

      function formatTimedWindow(windowMin) {
        if (timeLeftMin === null || !Number.isFinite(timeLeftMin)) return `${ANSI.gray}-${ANSI.reset}`;
        if (timeLeftMin <= windowMin && timeLeftMin > windowMin - 1) {
          return `${ANSI.green}AGORA${ANSI.reset} ${biasActionText}`;
        }
        if (timeLeftMin <= windowMin - 1) {
          return `${ANSI.gray}PASSOU${ANSI.reset}`;
        }
        return `${ANSI.yellow}AGUARDE${ANSI.reset}`;
      }
      const rec4m = formatTimedWindow(4);
      const rec3m = formatTimedWindow(3);

      const polyTimeLeftColor = settlementLeftMin !== null
        ? (settlementLeftMin >= 10 && settlementLeftMin <= 15
          ? ANSI.green
          : settlementLeftMin >= 5 && settlementLeftMin < 10
            ? ANSI.yellow
            : settlementLeftMin >= 0 && settlementLeftMin < 5
              ? ANSI.red
              : ANSI.reset)
        : ANSI.reset;

      const polyBlock = [
        kv("POLYMARKET:", polyHeaderValue),
        kv("Recomendacao:", recommendationText),
        liveEntryStatus ? kv("Status Trade:", liveEntryStatus) : null,
        kv("Advisor:", advisorLine),
        liquidity !== null ? kv("Liquidez:", formatNumber(liquidity, 0)) : null,
        settlementLeftMin !== null ? kv("Tempo restante:", `${polyTimeLeftColor}${fmtTimeLeft(settlementLeftMin)}${ANSI.reset}`) : null,
        priceToBeat !== null ? kv("PRECO A SUPERAR:", `$${formatNumber(priceToBeat, 0)}`) : kv("PRECO A SUPERAR:", `${ANSI.gray}-${ANSI.reset}`),
        currentPriceLine
      ].filter((x) => x !== null);

      const lines = [
        titleLine,
        marketLine,
        kv("Tempo restante:", `${timeColor}${fmtTimeLeft(timeLeftMin)}${ANSI.reset}`),
        "",
        sepLine(),
        "",
        kv("TA Prev:", predictValue),
        kv("Vies (Modelo+Ind):", biasLine),
        kv("Sinal Abertura 5m:", openSignalText),
        kv("Entrada (Janela):", entryGateText),
        kv("Recomendacao 4m:", rec4m),
        kv("Recomendacao 3m:", rec3m),
        kv("Sinais:", signalSummaryLine),
        kv("Heiken Ashi:", heikenLine.split(": ")[1] ?? heikenLine),
        kv("RSI:", rsiLine.split(": ")[1] ?? rsiLine),
        kv("MACD:", macdLine.split(": ")[1] ?? macdLine),
        kv("Delta 5/15:", deltaLine.split(": ")[1] ?? deltaLine),
        kv("VWAP:", vwapLine.split(": ")[1] ?? vwapLine),
        rec.action === "NO_TRADE" && rec.reason ? kv("Motivo Sem Trade:", String(rec.reason)) : null,
        "",
        sepLine(),
        "",
        ...polyBlock,
        "",
        sepLine(),
        "",
        kv("ET | Sessao:", `${ANSI.white}${fmtEtTime(new Date())}${ANSI.reset} | ${ANSI.white}${getBtcSession(new Date())}${ANSI.reset}`),
        "",
        sepLine(),
        centerText(`${ANSI.dim}${ANSI.gray}criado por @krajekis${ANSI.reset}`, screenWidth())
      ].filter((x) => x !== null);

      renderScreen(lines.join("\n") + "\n");

      prevSpotPrice = spotPrice ?? prevSpotPrice;
      prevCurrentPrice = currentPrice ?? prevCurrentPrice;



      // CSV será gravado apenas no fechamento do candle (com resultado final)
    } catch (err) {
      console.log("────────────────────────────");
      console.log(`Error: ${err?.message ?? String(err)}`);
      console.log("────────────────────────────");
    }

    await sleep(CONFIG.pollIntervalMs);
  }
}

main();
