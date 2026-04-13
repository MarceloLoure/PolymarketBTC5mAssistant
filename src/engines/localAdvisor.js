/**
 * src/engines/localAdvisor.js
 *
 * Decisão local pura — sem API, sem tokens.
 * Implementa as mesmas regras da skill polymarket-btc-signal.
 *
 * Retorna: { decision, side, phase, reason, entry, ve, risk }
 */

// ── Fase pelo tempo restante ───────────────────────────────────────────────
function getPhase(remainingMinutes) {
  if (remainingMinutes > 3)   return "EARLY";
  if (remainingMinutes > 1)   return "MID";
  if (remainingMinutes > 1/6) return "LATE";   // 10s = 1/6 de minuto
  return "FINAL";
}

// ── Thresholds por fase ────────────────────────────────────────────────────
const THRESHOLDS = {
  EARLY: { scoreMin: 0.40, signalsMin: 2, edgeMin: 0.02, deltaMin: 21  },
  MID:   { scoreMin: 0.50, signalsMin: 3, edgeMin: 0.03, deltaMin: 30  },
  LATE:  { scoreMin: 0.60, signalsMin: 0, edgeMin: 0.04, deltaMin: 51  },
  FINAL: { scoreMin: 0,    signalsMin: 0, edgeMin: 0.02, deltaMin: 77  }
};

// ── Estima probabilidade pelo delta quando modelo não está claro ───────────
function estimateProbByDelta(absDelta) {
  if (absDelta > 200) return 0.65;
  if (absDelta > 100) return 0.60;
  if (absDelta > 50)  return 0.55;
  return null; // incerto demais
}

// ── Cálculo de valor esperado com $1 ──────────────────────────────────────
function calcVE(prob, priceDecimal) {
  if (prob === null || priceDecimal === null) return null;
  const shares      = 1.0 / priceDecimal;
  const returnWin   = shares - 1.0;
  return (prob * returnWin) - ((1 - prob) * 1.0);
}

/**
 * Ponto de entrada principal.
 *
 * @param {Object} p
 * @param {number}      p.remainingMinutes  - Tempo restante em minutos
 * @param {number|null} p.score             - Score de confluência (-1 a +1)
 * @param {number}      p.bullCount         - Nº de sinais UP
 * @param {number}      p.bearCount         - Nº de sinais DOWN
 * @param {number|null} p.marketUp          - Preço UP em decimal (ex: 0.47)
 * @param {number|null} p.marketDown        - Preço DOWN em decimal (ex: 0.53)
 * @param {number|null} p.modelUp           - Probabilidade UP do modelo (0-1)
 * @param {number|null} p.modelDown         - Probabilidade DOWN do modelo (0-1)
 * @param {number|null} p.currentPrice      - Preço atual do BTC
 * @param {number|null} p.priceToBeat       - Strike do mercado
 * @param {string}      p.regime            - "TREND_UP"|"TREND_DOWN"|"RANGE"|"CHOP"
 *
 * @returns {{
 *   decision: "COMPRAR_UP"|"COMPRAR_DOWN"|"NAO_OPERAR",
 *   phase: string,
 *   reason: string,
 *   side: "UP"|"DOWN"|null,
 *   entryPrice: number|null,
 *   ve: number|null,
 *   returnIfWin: number|null,
 *   shares: number|null,
 *   edgeLiquid: number|null
 * }}
 */
export function localAdvisor({
  remainingMinutes,
  score,
  bullCount,
  bearCount,
  marketUp,
  marketDown,
  modelUp,
  modelDown,
  currentPrice,
  priceToBeat,
  regime,
  spread
}) {
  const NO_TRADE = (reason) => ({
    decision: "NAO_OPERAR",
    phase,
    reason,
    side: null,
    entryPrice: null,
    ve: null,
    returnIfWin: null,
    shares: null,
    edgeLiquid: null
  });

  const phase = getPhase(remainingMinutes);
  const cfg   = THRESHOLDS[phase];
  const spreadPenalty = Number.isFinite(spread)
    ? Math.min(0.03, Math.max(0.01, spread))
    : 0.02;

  // ── Bloqueio: regime CHOP ────────────────────────────────────────────────
  if (regime === "CHOP") return NO_TRADE("regime_chop");

  // ── Bloqueio: sem dados de mercado ───────────────────────────────────────
  if (marketUp === null || marketDown === null) return NO_TRADE("sem_precos_mercado");

  // ── Determina lado preferido pelo score ──────────────────────────────────
  const absScore = Math.abs(score ?? 0);
  const scoreSide = score > 0 ? "UP" : score < 0 ? "DOWN" : null;

  // ── Delta preço vs strike ─────────────────────────────────────────────────
  const delta = (currentPrice !== null && priceToBeat !== null && priceToBeat > 0)
    ? currentPrice - priceToBeat
    : null;
  const absDelta = delta !== null ? Math.abs(delta) : null;
  const deltaSide = delta === null ? null : delta > 0 ? "UP" : "DOWN";

  // ── Bloqueio: delta muito pequeno ────────────────────────────────────────
  if (absDelta !== null && absDelta < cfg.deltaMin) {
    const relaxedMin = cfg.deltaMin * 0.85;
    const strongScore = absScore >= 0.65 || Math.max(bullCount, bearCount) >= 4;
    if (!(strongScore && absDelta >= relaxedMin)) {
      return NO_TRADE(`delta_insuficiente_$${absDelta?.toFixed(0)}_min_$${cfg.deltaMin}`);
    }
  }

  // ── Determina lado final ──────────────────────────────────────────────────
  // Em LATE/FINAL: delta manda. Em EARLY/MID: score manda, delta confirma.
  let side;
  if (phase === "LATE" || phase === "FINAL") {
    side = deltaSide;
  } else {
    if (!scoreSide) return NO_TRADE("score_neutro");
    // Score e delta opostos = sinal contraditório
    if (deltaSide !== null && deltaSide !== scoreSide) {
      return NO_TRADE("score_e_delta_opostos");
    }
    side = scoreSide;
  }

  if (!side) return NO_TRADE("lado_indefinido");

  // ── Preço de entrada e prob do modelo ────────────────────────────────────
  const entryPrice  = side === "UP" ? marketUp   : marketDown;
  const modelProb   = side === "UP" ? modelUp    : modelDown;
  const sideCount   = side === "UP" ? bullCount  : bearCount;

  // ── Bloqueio: preço acima de 85¢ ─────────────────────────────────────────
  if (entryPrice > 0.85) {
    return NO_TRADE(`preco_alto_${(entryPrice * 100).toFixed(0)}c_max_85c`);
  }

  // ── Bloqueio: score insuficiente (só EARLY/MID) ──────────────────────────
  if (phase !== "LATE" && phase !== "FINAL") {
    if (absScore < cfg.scoreMin) {
      return NO_TRADE(`score_${absScore.toFixed(2)}_min_${cfg.scoreMin}`);
    }
  }

  // ── Bloqueio: sinais insuficientes (só EARLY/MID) ────────────────────────
  if (cfg.signalsMin > 0 && sideCount < cfg.signalsMin) {
    if (absScore < 0.7) {
      return NO_TRADE(`sinais_${sideCount}_min_${cfg.signalsMin}`);
    }
  }

  // ── Calcula probabilidade e edge ─────────────────────────────────────────
  let prob = modelProb;

  // Se modelo não disponível ou fraco, usa estimativa pelo delta
  if ((prob === null || (prob > 0.48 && prob < 0.52)) && absDelta !== null) {
    prob = estimateProbByDelta(absDelta);
  }

  if (prob === null) return NO_TRADE("prob_indefinida");

  const edge        = prob - entryPrice;
  const edgeLiquid  = edge - spreadPenalty;    // desconta spread estimado

  // ── Bloqueio: edge insuficiente ──────────────────────────────────────────
  if (edge <= 0)               return NO_TRADE(`edge_negativo_${(edge * 100).toFixed(1)}pct`);
  if (edgeLiquid < cfg.edgeMin) return NO_TRADE(`edge_liquido_${(edgeLiquid * 100).toFixed(1)}pct_min_${(cfg.edgeMin * 100).toFixed(0)}pct`);

  // ── Calcula VE ────────────────────────────────────────────────────────────
  const ve = calcVE(prob, entryPrice);

  // ── Bloqueio: VE abaixo de 1% ────────────────────────────────────────────
  if (ve === null || ve < 0.01) {
    return NO_TRADE(`ve_${((ve ?? 0) * 100).toFixed(1)}pct_min_1pct`);
  }

  // ── Monta resultado de entrada ────────────────────────────────────────────
  const shares      = 1.0 / entryPrice;
  const returnIfWin = shares - 1.0;

  return {
    decision:    side === "UP" ? "COMPRAR_UP" : "COMPRAR_DOWN",
    phase,
    reason:      `edge_${(edgeLiquid * 100).toFixed(1)}pct_ve_${(ve * 100).toFixed(1)}pct`,
    side,
    entryPrice,
    ve,
    returnIfWin,
    shares,
    edgeLiquid
  };
}

/**
 * Formata o resultado para exibição no terminal do assistente.
 * Retorna uma string curta (1 linha) para caber no display.
 */
export function formatAdvisorLine(result, ANSI = {}) {
  const g  = ANSI.green   ?? "";
  const r  = ANSI.red     ?? "";
  const gr = ANSI.gray    ?? "";
  const y  = ANSI.yellow  ?? "";
  const rs = ANSI.reset   ?? "";

  if (result.decision === "COMPRAR_UP") {
    const ret = ((result.returnIfWin ?? 0) * 100).toFixed(0);
    const ve  = ((result.ve ?? 0) * 100).toFixed(1);
    return `${g}▲ COMPRAR UP${rs} ${(result.entryPrice * 100).toFixed(0)}¢ | retorno +${ret}% | VE +${ve}%`;
  }

  if (result.decision === "COMPRAR_DOWN") {
    const ret = ((result.returnIfWin ?? 0) * 100).toFixed(0);
    const ve  = ((result.ve ?? 0) * 100).toFixed(1);
    return `${r}▼ COMPRAR DOWN${rs} ${(result.entryPrice * 100).toFixed(0)}¢ | retorno +${ret}% | VE +${ve}%`;
  }

  // NAO_OPERAR — mostra o motivo simplificado
  const motivo = result.reason
    .replace(/_/g, " ")
    .replace("score e delta opostos", "sinais contraditórios")
    .replace("regime chop", "mercado parado")
    .replace("preco alto", "preço alto");

  return `${gr}— SEM TRADE${rs} ${y}(${motivo})${rs}`;
}
