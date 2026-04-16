import { learningState } from "./learningState.js";

// engines/polymarketSkill.js

function getMarketBoundaries(candles) {
  if (!candles || candles.length === 0) return { max: Infinity, min: -Infinity };
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  return { max: Math.max(...highs), min: Math.min(...lows) };
}

export function polymarketPropEngine(input, historicalCandles) {
  const {
    timeLeftMin, score, bullCount, bearCount,
    marketUp, marketDown, modelUp, modelDown,
    currentPrice, priceToBeat, rsi,
    regime, heikenColor, heikenColor5m
  } = input;

  const boundaries = getMarketBoundaries(historicalCandles);
  const delta = currentPrice - priceToBeat;
  const side = delta > 0 ? "UP" : "DOWN";
  const marketPrice = side === "UP" ? marketUp : marketDown;

  // ==========================================================
  // 🔥 FILTRO DE SOBREVIVÊNCIA (ANTI-SUICÍDIO 0.99)
  // ==========================================================
  // Não entramos se o lucro for ridículo comparado ao risco do Stop Loss.
  if (marketPrice > 0.80) {
    return { action: "NO_TRADE", reason: "RISCO_RETORNO_RUIM", debug: { price: marketPrice } };
  }
  // Se o mercado acha que a chance é menor que 25%, ele sabe de algo que nós não sabemos.
  if (marketPrice < 0.25) {
    return { action: "NO_TRADE", reason: "MUITO_CONTRA_FLUXO", debug: { price: marketPrice } };
  }

  // 1. VALIDAÇÃO BÁSICA
  if (timeLeftMin == null || !marketUp || !modelUp || !priceToBeat) {
    return { action: "NO_TRADE", reason: "DADOS_INCOMPLETOS" };
  }

  // 2. SNIPER DE FINAL DE CANDLE (Aumentamos a exigência de 0.80 para 0.88)
  if (timeLeftMin <= 0.5 && timeLeftMin > 0.15) {
      if (marketPrice > 0.75 && Math.abs(score) > 0.88) {
          return { action: "ENTER", side, phase: "SUPER_SNIPER", score: Math.abs(score) };
      }
      return { action: "NO_TRADE", reason: "JANELA_FINAL_SEM_CONVICCAO" };
  }

  // 3. FILTRO HEIKEN ASHI (Voltamos para 1m + 5m para estancar o sangue dos logs)
  const isSideAligned = (side === "UP" && heikenColor === "green" && heikenColor5m === "green") ||
                        (side === "DOWN" && heikenColor === "red" && heikenColor5m === "red");

  if (!isSideAligned) {
    return { action: "NO_TRADE", reason: `HA_CONTRA_DIRECAO (${heikenColor}/${heikenColor5m})` };
  }

  // 4. RESISTÊNCIA/SUPORTE (PROTEÇÃO DE TOPO/FUNDO)
  if (side === "UP" && currentPrice >= boundaries.max * 0.9999) {
      if (regime !== "STRONG_TREND" || Math.abs(score) < 0.85) 
        return { action: "NO_TRADE", reason: "TOPO_HISTORICO_SEM_FORCA" };
  }
  if (side === "DOWN" && currentPrice <= boundaries.min * 1.0001) {
      if (regime !== "STRONG_TREND" || Math.abs(score) < 0.85)
        return { action: "NO_TRADE", reason: "FUNDO_HISTORICO_SEM_FORCA" };
  }

  // 5. COLCHÃO DE SEGURANÇA (Aumentamos levemente para evitar ruído)
  const absDelta = Math.abs(delta);
  const displacementPct = absDelta / priceToBeat;
  let minRequired = timeLeftMin > 3 ? 0.00055 : (timeLeftMin > 1.5 ? 0.0008 : 0.0012);

  if (Math.abs(score) > 0.80) minRequired *= 0.75; 

  if (displacementPct < minRequired) {
    return { 
      action: "NO_TRADE", 
      reason: "COLCHAO_INSUFICIENTE",
      debug: { targetPrice: (priceToBeat * (side === "UP" ? 1+minRequired : 1-minRequired)).toFixed(2), minRequired }
    };
  }

  // 6. CONFLUÊNCIA E EDGE (A "ZONA 0.52")
  const sideScore = side === "UP" ? score : -score;
  const minScore = timeLeftMin > 3 ? 0.45 : 0.55;

  if (sideScore < minScore || (side === "UP" ? bullCount : bearCount) < 4) {
    return { action: "NO_TRADE", reason: "SINAIS_INSUFICIENTES" };
  }

  const myProb = side === "UP" ? modelUp : modelDown;
  const edge = myProb - marketPrice;
  const EV = (myProb * 1) - marketPrice;

  // Na zona de 0.50, aceitamos um Edge menor. Se for caro, exigimos 8%!
  const requiredEdge = marketPrice > 0.65 ? 0.08 : 0.045;

  if (edge < requiredEdge || EV < 0.02) {
    return { action: "NO_TRADE", reason: "SEM_VANTAGEM_MATEMATICA" };
  }

  // 7. RSI FINAL
  if ((side === "UP" && rsi > 72) || (side === "DOWN" && rsi < 28)) {
    return { action: "NO_TRADE", reason: "MERCADO_EXAUSTO" };
  }

  return {
    action: "ENTER",
    side,
    phase: timeLeftMin > 3 ? "EARLY" : "MID",
    edge,
    ev: EV,
    score: Math.abs(score),
    strength: Math.abs(score) > 0.80 ? "STRONG" : "MEDIUM"
  };
}

export function buildSmartAdvisor(rec, ctx, ANSI) {
  if (!rec) return `${ANSI.gray}NO SIGNAL${ANSI.reset}`;

  // ========================
  // 1. NO TRADE (DESK STYLE)
  // ========================
  if (rec.action === "NO_TRADE") {
    const d = rec.debug || {};

    const reasonBook = {
      "DELTA FRACO": `NO SETUP | insufficient displacement (missing ${d.missing ?? "-"})`,
      "SEM EDGE": `NO EDGE | edge ${d.edge?.toFixed(4) ?? "-"} < min ${d.minEdge?.toFixed(4) ?? "-"}`,
      "EV BAIXO": `NO VALUE | EV ${d.ev?.toFixed(4) ?? "-"} below threshold`,
      "CONFLITO": `SIGNAL CONFLICT | imbalance ${(d.imbalance ?? 0).toFixed(2)}`,
      "DADOS INSUFICIENTES": `INSUFFICIENT DATA`
    };

    return `${ANSI.gray}[NO TRADE]${ANSI.reset} ${reasonBook[rec.reason] || rec.reason}`;
  }

  // ========================
  // 2. CONTEXT
  // ========================
  const { side, edge, ev, regime, strength, scoreFinal } = rec;
  const { score, timeLeftMin } = ctx;

  // ========================
  // 3. CONFIDENCE MODEL (0–100)
  // ========================
  const rawConfidence =
    (scoreFinal * 0.6 + Math.max(edge, 0) * 0.4) * 100;

  const confidence = Math.max(0, Math.min(100, rawConfidence));

  // ========================
  // 4. SETUP CLASSIFICATION (PROP STYLE)
  // ========================
  let setup = "CHOP";

  if (regime === "STRONG_TREND" && edge > 0.03) {
    setup = "CONTINUATION";
  } else if (regime === "TREND" && ev > 0.01) {
    setup = "TREND FOLLOW";
  } else if (edge > 0.04 && score < 0) {
    setup = "REVERSAL";
  } else if (confidence < 35) {
    setup = "NOISE";
  }

  // ========================
  // 5. TRADE QUALITY (DESK RATING)
  // ========================
  let rating = "C";

  if (confidence > 75 && setup === "CONTINUATION") rating = "A+";
  else if (confidence > 65 && ev > 0.015) rating = "A";
  else if (confidence > 50) rating = "B";

  // ========================
  // 6. RISK QUALITY
  // ========================
  const riskQuality =
    regime === "STRONG_TREND" ? "LOW RISK" :
    regime === "TREND" ? "MEDIUM RISK" :
    "HIGH RISK";

  // ========================
  // 7. URGENCY
  // ========================
  let urgency = "NORMAL";

  if (timeLeftMin < 0.5) urgency = "CRITICAL";
  else if (timeLeftMin < 1.5) urgency = "URGENT";
  else if (timeLeftMin < 3) urgency = "FAST MOVE";

  // ========================
  // 8. COLORS
  // ========================
  const sideColor = side === "UP" ? ANSI.green : ANSI.red;

  const ratingColor =
    rating === "A+" ? ANSI.green :
    rating === "A" ? ANSI.green :
    rating === "B" ? ANSI.yellow :
    ANSI.gray;

  const setupColor =
    setup === "CONTINUATION" ? ANSI.green :
    setup === "REVERSAL" ? ANSI.red :
    setup === "TREND FOLLOW" ? ANSI.yellow :
    ANSI.gray;

  const urgencyColor =
    urgency === "CRITICAL" ? ANSI.red :
    urgency === "URGENT" ? ANSI.yellow :
    ANSI.gray;

  const riskColor =
    riskQuality === "LOW RISK" ? ANSI.green :
    riskQuality === "MEDIUM RISK" ? ANSI.yellow :
    ANSI.red;

  // ========================
  // 9. OUTPUT (DESK FORMAT)
  // ========================
  const safeConf = (confidence || 0).toFixed(1);
  const safeEdge = (edge || 0).toFixed(3);
  const safeEv = (ev || 0).toFixed(3);
  const safeScore = (rec.score || rec.scoreFinal || 0).toFixed(3); // Aceita os dois nomes

  return [
    `${sideColor}${side}${ANSI.reset}`,
    `${ratingColor}${rating}${ANSI.reset}`,
    `${setupColor}${setup}${ANSI.reset}`,
    `${riskColor}${riskQuality}${ANSI.reset}`,
    `${urgencyColor}${urgency}${ANSI.reset}`,
    `conf ${safeConf}%`,
    `edge ${safeEdge}`,
    `ev ${safeEv}`,
    `score ${safeScore}`
  ].join(" | ");
}

export function computeDisplacement2({
  currentPrice,
  priceToBeat,
  vwapSlope,
  rsi,
  macdHist,
  modelUp,
  modelDown,
  marketUp,
  marketDown,
  recentRange,     // ATR-like
  delta5m,
  delta15m
}) {

  if (currentPrice == null || priceToBeat == null) {
    return { score: 0, reason: "NO DATA" };
  }

  // =========================
  // 1. NORMALIZED MOVE
  // =========================
  const delta = currentPrice - priceToBeat;
  const normMove = recentRange > 0 ? Math.abs(delta) / recentRange : 0;

  // =========================
  // 2. MOMENTUM
  // =========================
  const momentum =
    (delta5m || 0) * 0.6 +
    (delta15m || 0) * 0.4;

  const momentumScore = Math.tanh(momentum / 100);

  // =========================
  // 3. ALIGNMENT
  // =========================
  const modelBias = (modelUp - modelDown) / Math.max(modelUp + modelDown, 0.0001);
  const marketBias = (marketUp - marketDown) / Math.max(marketUp + marketDown, 0.0001);

  const alignment =
    Math.sign(modelBias) === Math.sign(marketBias) ? 1 : 0;

  // =========================
  // 4. STRUCTURE (trend confirmation)
  // =========================
  let structure = 0;

  if (vwapSlope > 0 && delta > 0) structure += 0.3;
  if (vwapSlope < 0 && delta < 0) structure += 0.3;

  if (rsi > 55 && delta > 0) structure += 0.2;
  if (rsi < 45 && delta < 0) structure += 0.2;

  if (macdHist > 0 && delta > 0) structure += 0.2;
  if (macdHist < 0 && delta < 0) structure += 0.2;

  structure = Math.min(1, structure);

  // =========================
  // 5. FINAL SCORE
  // =========================
  let score =
    (normMove * 0.35) +
    (Math.abs(momentumScore) * 0.25) +
    (structure * 0.25) +
    (alignment * 0.15);

  score = Math.max(0, Math.min(1, score));

  // =========================
  // 6. CLASSIFICATION
  // =========================
  let state = "CHOP";

  if (score > 0.7) state = "STRONG_DISPLACEMENT";
  else if (score > 0.5) state = "VALID_MOVE";
  else if (score > 0.3) state = "WEAK_MOVE";

  return {
    score,
    state,
    delta,
    normMove,
    momentumScore,
    structure,
    alignment
  };
}