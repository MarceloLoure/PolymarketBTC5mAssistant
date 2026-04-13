import { clamp } from "../utils.js";

/**
 * Calcula edge do modelo vs preços de mercado.
 * Inalterado — funciona bem.
 */
export function computeEdge({ modelUp, modelDown, marketYes, marketNo }) {
  if (marketYes === null || marketNo === null) {
    return { marketUp: null, marketDown: null, edgeUp: null, edgeDown: null };
  }

  const sum = marketYes + marketNo;
  const marketUp   = sum > 0 ? clamp(marketYes / sum, 0, 1) : null;
  const marketDown = sum > 0 ? clamp(marketNo  / sum, 0, 1) : null;

  return {
    marketUp,
    marketDown,
    edgeUp:   marketUp   === null ? null : modelUp   - marketUp,
    edgeDown: marketDown === null ? null : modelDown - marketDown
  };
}

/**
 * Decide se deve entrar, em qual lado e com qual força.
 *
 * Parâmetros adicionais:
 * @param {number} score         - Score de confluência (-1 a +1) de probability.js
 * @param {number} bullCount     - Quantos sinais apontaram UP
 * @param {number} bearCount     - Quantos sinais apontaram DOWN
 * @param {number} totalSignals  - Total de sinais avaliados
 * @param {string} regime        - Regime de mercado atual
 */
export function decide({
  remainingMinutes,
  edgeUp,
  edgeDown,
  modelUp   = null,
  modelDown = null,
  score     = 0,
  bullCount = 0,
  bearCount = 0,
  totalSignals = 0,
  regime    = "RANGE"
}) {
  // ── Fase temporal ──────────────────────────────────────────────────────────
  const phase =
    remainingMinutes > 8 ? "EARLY" :
    remainingMinutes > 3 ? "MID"   : "LATE";

  // ── Thresholds por fase ────────────────────────────────────────────────────
  // EARLY: mais permissivo (tendência ainda pode se desenvolver)
  // LATE:  muito restritivo (mercado já formou preço, edge deve ser grande)
  const cfg = {
    EARLY: { edgeMin: 0.035, probMin: 0.52, confMin: 0.40, bullBearMin: 2 },
    MID:   { edgeMin: 0.065, probMin: 0.55, confMin: 0.50, bullBearMin: 3 },
    LATE:  { edgeMin: 0.12,  probMin: 0.60, confMin: 0.60, bullBearMin: 4 }
  }[phase];

  // ── Sem dados de mercado ───────────────────────────────────────────────────
  if (edgeUp === null || edgeDown === null) {
    return { action: "NO_TRADE", side: null, phase, reason: "sem_dados_mercado" };
  }

  // ── Regime CHOP: não operar ────────────────────────────────────────────────
  if (regime === "CHOP") {
    return { action: "NO_TRADE", side: null, phase, reason: "regime_chop" };
  }

  // ── Determina lado preferido ───────────────────────────────────────────────
  const bestSide  = edgeUp > edgeDown ? "UP" : "DOWN";
  const bestEdge  = bestSide === "UP" ? edgeUp  : edgeDown;
  const bestModel = bestSide === "UP" ? modelUp : modelDown;
  const bestCount = bestSide === "UP" ? bullCount : bearCount;

  // ── Verifica se score de confluência concorda com o lado ──────────────────
  const scoreAgrees =
    (bestSide === "UP"   && score >= cfg.confMin) ||
    (bestSide === "DOWN" && score <= -cfg.confMin);

  if (!scoreAgrees) {
    return { action: "NO_TRADE", side: null, phase, reason: "confluencia_insuficiente" };
  }

  // ── Edge mínimo ────────────────────────────────────────────────────────────
  if (bestEdge < cfg.edgeMin) {
    return {
      action: "NO_TRADE", side: null, phase,
      reason: `edge_abaixo_${(cfg.edgeMin * 100).toFixed(0)}pct`
    };
  }

  // ── Probabilidade mínima do modelo ────────────────────────────────────────
  if (bestModel !== null && bestModel < cfg.probMin) {
    return {
      action: "NO_TRADE", side: null, phase,
      reason: `prob_abaixo_${(cfg.probMin * 100).toFixed(0)}pct`
    };
  }

  // ── Confluência de indicadores ─────────────────────────────────────────────
  if (bestCount < cfg.bullBearMin) {
    return {
      action: "NO_TRADE", side: null, phase,
      reason: `indicadores_insuficientes_${bestCount}_de_${cfg.bullBearMin}`
    };
  }

  // ── Força do sinal ─────────────────────────────────────────────────────────
  const absScore = Math.abs(score);
  const strength =
    bestEdge >= 0.20 && absScore >= 0.65 ? "FORTE"    :
    bestEdge >= 0.10 && absScore >= 0.50 ? "MODERADO" : "FRACO";

  // Sinal FRACO: só aceitar em EARLY com regime de tendência
  if (strength === "FRACO" && (phase !== "EARLY" || !regime.startsWith("TREND"))) {
    return { action: "NO_TRADE", side: null, phase, reason: "sinal_fraco_fase_errada" };
  }

  return {
    action: "ENTER",
    side: bestSide,
    phase,
    strength,
    edge: bestEdge,
    score,
    reason: `${bestCount}/${totalSignals}_sinais_${strength.toLowerCase()}`
  };
}
