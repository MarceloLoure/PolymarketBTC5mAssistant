import { learningState } from "./learningState.js";

// engines/polymarketSkill.js

export function polymarketPropEngine(input) {
  const {
    timeLeftMin, score, bullCount, bearCount,
    marketUp, marketDown, modelUp, modelDown,
    currentPrice, priceToBeat, rsi,
    regime, heikenColor, heikenColor5m
  } = input;

  // 1. VALIDAÇÃO E TRAVA DE SEGURANÇA (TIME LOCK)
  if (timeLeftMin == null || !marketUp || !modelUp || !priceToBeat) {
    return { action: "NO_TRADE", reason: "DADOS_INCOMPLETOS" };
  }
  
  // Bloqueia se faltar menos de 42 segundos para evitar slippage e volatilidade final
  if (timeLeftMin <= 0.7) return { action: "NO_TRADE", reason: "JANELA_MUITO_CURTA" };

  // 2. FILTRO DE ALINHAMENTO TRIPLO (DIREÇÃO + MOMENTUM)
  const delta = currentPrice - priceToBeat;
  const side = delta > 0 ? "UP" : "DOWN";

  // Só entra se o Lado do trade bater com a cor do Heiken Ashi 1m e 5m (Assertividade Máxima)
  const isSideAligned = (side === "UP" && heikenColor === "green" && heikenColor5m === "green") ||
                        (side === "DOWN" && heikenColor === "red" && heikenColor5m === "red");

  if (!isSideAligned) {
    return { action: "NO_TRADE", reason: `HA_CONTRA_DIRECAO (${heikenColor}/${heikenColor5m})` };
  }

  // 3. COLCHÃO DE SEGURANÇA COM "TREND BOOST"
  const absDelta = Math.abs(delta);
  const displacementPct = absDelta / priceToBeat;
  
  // Base de distância por fase
  let minRequired = timeLeftMin > 3 ? 0.0005 : (timeLeftMin > 1.5 ? 0.0008 : 0.0012);

  // REDUÇÃO DE EXIGÊNCIA: Se a tendência é muito forte (score > 0.75), afrouxamos o colchão em 30%
  if (Math.abs(score) > 0.75) {
    minRequired *= 0.7; 
  }

  const targetPrice = side === "UP" 
    ? priceToBeat * (1 + minRequired) 
    : priceToBeat * (1 - minRequired);

  if (displacementPct < minRequired) {
    return { 
      action: "NO_TRADE", 
      reason: `ABAIXO_DO_COLCHAO_SEGURANCA (${(displacementPct*100).toFixed(4)}%)`,
      debug: {
        targetPrice: targetPrice.toFixed(2),
        minRequiredPct: (minRequired * 100).toFixed(2) + "%"
      }
    };
  }

  // 4. CONFLUÊNCIA DE SINAIS (SCORE + COUNT)
  const minScore = timeLeftMin > 3 ? 0.45 : 0.55;
  const sideScore = side === "UP" ? score : -score;
  const sideCount = side === "UP" ? bullCount : bearCount;

  if (sideScore < minScore || sideCount < 4) {
    return { action: "NO_TRADE", reason: `CONFLUENCIA_INSUFICIENTE (Score: ${sideScore.toFixed(2)})` };
  }

  // 5. EDGE DINÂMICO (FILTRO DE PREÇO JUSTO)
  const myProb = side === "UP" ? modelUp : modelDown;
  const marketPrice = side === "UP" ? marketUp : marketDown;
  const edge = myProb - marketPrice;
  const EV = (myProb * 1) - marketPrice;

  // Se o token estiver "caro" (>0.50), exigimos um Edge maior (6%) para compensar o risco
  const requiredEdge = marketPrice > 0.50 ? 0.06 : 0.045;

  if (edge < requiredEdge || EV < 0.02) {
    return { action: "NO_TRADE", reason: "EDGE_INSUFICIENTE_PARA_PRECO_ALTO" };
  }

  // 6. FILTROS DE EXAUSTÃO
  if ((side === "UP" && rsi > 70) || (side === "DOWN" && rsi < 30)) {
    return { action: "NO_TRADE", reason: "EXAUSTAO_RSI_DETECTADA" };
  }

  return {
    action: "ENTER",
    side,
    phase: timeLeftMin > 3 ? "EARLY" : (timeLeftMin > 1.5 ? "MID" : "LATE"),
    edge,
    ev: EV,
    score: Math.abs(score),
    strength: Math.abs(score) > 0.75 ? "STRONG" : "MEDIUM"
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
  return [
    `${sideColor}${side}${ANSI.reset}`,
    `${ratingColor}${rating}${ANSI.reset}`,
    `${setupColor}${setup}${ANSI.reset}`,
    `${riskColor}${riskQuality}${ANSI.reset}`,
    `${urgencyColor}${urgency}${ANSI.reset}`,
    `conf ${confidence.toFixed(1)}%`,
    `edge ${edge.toFixed(3)}`,
    `ev ${ev.toFixed(3)}`,
    `score ${(scoreFinal ?? 0).toFixed(3)}`
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