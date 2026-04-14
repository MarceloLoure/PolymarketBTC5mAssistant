import { learningState } from "./learningState.js";

export function polymarketPropEngine(input) {
  const {
    timeLeftMin,
    score,
    bullCount = 0,
    bearCount = 0,
    marketUp,
    marketDown,
    modelUp,
    modelDown,
    currentPrice,
    priceToBeat,
    rsi
  } = input;

  // =========================
  // 1. VALIDATION
  // =========================
  if (
    timeLeftMin == null ||
    marketUp == null ||
    marketDown == null ||
    modelUp == null ||
    modelDown == null
  ) {
    return { action: "NO_TRADE", reason: "DADOS INSUFICIENTES" };
  }

  // =========================
  // 2. PHASE (prop logic)
  // =========================
  let phase = "EARLY";
  if (timeLeftMin > 5) phase = "EARLY";
  else if (timeLeftMin > 2) phase = "MID";
  else if (timeLeftMin > 0.5) phase = "LATE";
  else phase = "FINAL";

  // =========================
  // 3. DIRECTION
  // =========================
  const modelBias = modelUp - modelDown;
  const marketBias = marketUp - marketDown;
  const scoreBias = score;

  const directionScore = modelBias + marketBias + scoreBias;

  const side = directionScore > 0 ? "UP" : "DOWN";

  

  // =========================
  // DISPLACEMENT 2.0 FLEX (V3)
  // =========================

  const delta = currentPrice - priceToBeat;
  const displacementPct = Math.abs(delta) / priceToBeat;

  // base por fase (bem mais leve agora)
  const baseRequiredByPhase = {
    EARLY: 0.0008, // 0.08%
    MID:   0.0012,
    LATE:  0.0016,
    FINAL: 0.0020
  };

  let required = baseRequiredByPhase[phase] ?? 0.0012;

  // =========================
  // 1. SCORE ADAPTATION (trend strength)
  // =========================
  const absScore = Math.abs(score);

  if (absScore > 0.7) required *= 0.75;  // forte tendência → menos exigência
  else if (absScore < 0.3) required *= 1.4; // chop → exige mais movimento

  // =========================
  // 2. VOLATILITY ADAPTATION (market behavior)
  // =========================
  const volatility = Math.abs(marketUp - marketDown);

  if (volatility > 0.08) required *= 0.8;  // mercado agressivo
  if (volatility < 0.03) required *= 1.3;  // mercado parado

  // =========================
  // 3. RSI EXTREMES (boost permission)
  // =========================
  if (rsi != null) {
    if (rsi > 70 || rsi < 30) {
      required *= 0.85; // deixa entrar mais fácil em extremos
    }
  }

  const marketProbUp = marketUp;
  const marketProbDown = marketDown;

  // =========================
  // EXTREME PROBABILITY ZONE (BIDIRECTIONAL)
  // =========================

  // 🔥 ZONA EXTREMA UP (crowded long)
  if (marketProbUp > 0.87) {

    const modelAgreement = modelUp > modelDown;

    if (!modelAgreement || score < 0.4) {
      return {
        action: "NO_TRADE",
        reason: "EXTREME UP ZONE (OVERPRICED LONG)",
        debug: {
          marketProbUp,
          modelUp,
          score
        }
      };
    }

    if (score > 0.7 && modelUp > 0.6) {
      return {
        action: "ENTER",
        side: "UP",
        reason: "EXTREME UP CONTINUATION",
        note: "crowded long but momentum strong"
      };
    }

    return {
      action: "NO_TRADE",
      reason: "EXTREME UP - WAIT CONFIRMATION",
      debug: {
        marketProbUp,
        score
      }
    };
  }

  // =========================
  // 🔥 ZONA EXTREMA DOWN (crowded short)
  // =========================
  if (marketProbDown > 0.85) {

    const modelAgreement = modelDown > modelUp;

    if (!modelAgreement || score < 0.4) {
      return {
        action: "NO_TRADE",
        reason: "EXTREME DOWN ZONE (OVERPRICED SHORT)",
        debug: {
          marketProbDown,
          modelDown,
          score
        }
      };
    }

    if (score > 0.7 && modelDown > 0.6) {
      return {
        action: "ENTER",
        side: "DOWN",
        reason: "EXTREME DOWN CONTINUATION",
        note: "crowded short but momentum strong"
      };
    }

    return {
      action: "NO_TRADE",
      reason: "EXTREME DOWN - WAIT CONFIRMATION",
      debug: {
        marketProbDown,
        score
      }
    };
  }

  // =========================
  // 4. FINAL SCORE
  // =========================
  const displacementScore = displacementPct / required;

  // =========================
  // 5. ZONE (não binário)
  // if (displacementScore < 0.5) {
  //   return {
  //     action: "NO_TRADE",
  //     reason: "INSUFFICIENT DISPLACEMENT",
  //     debug: {
  //       displacementPct,
  //       required,
  //       score: displacementScore,
  //       phase
  //     }
  //   };
  // }

// opcional: warning zone (sem bloquear)
const isWeak = displacementScore < 0.8;

  // =========================
  // 5. CONFLUENCE FILTER
  // =========================

  const modelBiasNorm =
    modelUp - modelDown;

  const marketBiasNorm =
    marketUp - marketDown;

  const alignmentScore =
    modelBiasNorm * 0.65 +
    marketBiasNorm * 0.35;

  // força direcional real
  const alignmentStrength = Math.abs(alignmentScore);

  // 🔥 threshold dinâmico (isso muda tudo)
  const minAlignment =
    phase === "EARLY" ? 0.05 :
    phase === "MID"   ? 0.065 :
    phase === "LATE"  ? 0.07 :
                        0.09;

  // ❌ só bloqueia se estiver MUITO fraco
  if (alignmentStrength < minAlignment) {
    return {
      action: "NO_TRADE",
      reason: `WEAK ALIGNMENT (SCORE ${alignmentScore.toFixed(3)}) - BELOW THRESHOLD ${minAlignment}`,
      debug: {
        alignmentScore,
        alignmentStrength,
        minAlignment,
        phase
      }
    };
  }

  // =========================
  // 6. SCORE FILTER (PROP GRADE)
  // =========================

  const minScore =
    phase === "EARLY" ? 0.50 :
    phase === "MID"   ? 0.40 :
    phase === "LATE"  ? 0.35 :
                        0.3;

  // leve penalidade por desalinhamento fraco
  const alignmentPenalty =
    alignmentStrength < 0.1 ? 0.05 : 0;

  const adjustedScore = Math.abs(score) - alignmentPenalty;

  if (adjustedScore < minScore) {
    return {
      action: "NO_TRADE",
      reason: `SCORE BAIXO (AJUSTADO ${adjustedScore.toFixed(3)} < MIN ${minScore})`,
      debug: {
        score,
        adjustedScore,
        minScore,
        alignmentStrength
      }
    };
  }

  // =========================
  // 7. MARKET MICROSTRUCTURE FILTER
  // =========================
  const spread = Math.abs(marketUp - marketDown);

  if (spread > 6) {
    return {
      action: "NO_TRADE",
      reason: "SPREAD ALTO",
      debug: { spread }
    };
  }

  // =========================
  // 8. EDGE CALCULATION
  // =========================
  const probUp = modelUp;
  const probDown = modelDown;

  const edge =
    side === "UP"
      ? probUp - marketUp
      : probDown - marketDown;

  const MIN_EDGE =
    phase === "EARLY" ? 0.04 :
    phase === "MID"   ? 0.03 :
    phase === "LATE"  ? 0.02 :
                        0.015;

  if (edge < MIN_EDGE) {
    return {
      action: "NO_TRADE",
      reason: "SEM EDGE",
      debug: { edge, minEdge: MIN_EDGE }
    };
  }

  // =========================
  // 9. EXPECTED VALUE (PROP CORE)
  // =========================
  const price = side === "UP" ? marketUp : marketDown;

  const payout = 1;
  const EV = (side === "UP" ? probUp : probDown) * payout - price;

  const MIN_EV =
    phase === "EARLY" ? 0.02 :
    phase === "MID"   ? 0.015 :
    phase === "LATE"  ? 0.01 :
                        0.008;

  if (EV < MIN_EV) {
    return {
      action: "NO_TRADE",
      reason: "EV BAIXO",
      debug: { ev: EV, minEv: MIN_EV }
    };
  }

  // =========================
  // 10. CONFLUENCE BOOST
  // =========================
  const bullBearImbalance =
    bullCount + bearCount > 0
      ? (bullCount - bearCount) / (bullCount + bearCount)
      : 0;

  const confluenceBoost =
    Math.abs(bullBearImbalance) > 0.3 ? 0.05 : 0;

  const finalScore =
    (edge * 0.5) +
    (EV * 0.3) +
    (Math.abs(score) * 0.2) +
    confluenceBoost;

  // =========================
  // 11. STRENGTH
  // =========================
  let strength = "WEAK";

  if (finalScore > 0.08) strength = "STRONG";
  else if (finalScore > 0.05) strength = "MEDIUM";

  // =========================
  // 12. FINAL
  // =========================
  return {
    action: "ENTER",
    side,
    phase,
    edge,
    ev: EV,
    prob: side === "UP" ? probUp : probDown,
    score,
    finalScore,
    strength
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