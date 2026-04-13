import { clamp } from "../utils.js";

/**
 * Avalia cada indicador individualmente e retorna +1 (UP), -1 (DOWN) ou 0 (neutro).
 * Cada sinal é independente — a confluência é calculada depois.
 */
function evalSignals({
  price,
  vwap,
  vwapSlope,
  rsi,
  rsiSlope,
  macd,
  heikenColor,
  heikenCount,
  heikenColor5m,
  heikenCount5m,
  failedVwapReclaim,
  priceToBeat,
  volume20,
  volumeAvg,
  regime
}) {
  const signals = [];

  // ── 1. VWAP posição + slope ────────────────────────────────────────────────
  // Precisa de AMBOS concordando para contar — filtra ruído em lateralização.
  if (price !== null && vwap !== null && vwapSlope !== null) {
    if (price > vwap && vwapSlope > 0)  signals.push({ name: "vwap", dir: 1,  weight: 1.5 });
    else if (price < vwap && vwapSlope < 0) signals.push({ name: "vwap", dir: -1, weight: 1.5 });
    else signals.push({ name: "vwap", dir: 0, weight: 1.5 });
  }

  // ── 2. RSI nível + slope ───────────────────────────────────────────────────
  // RSI sozinho sem slope = ruído; exige os dois.
  if (rsi !== null && rsiSlope !== null) {
    if (rsi > 55 && rsiSlope > 0)      signals.push({ name: "rsi", dir: 1,  weight: 1.0 });
    else if (rsi < 45 && rsiSlope < 0) signals.push({ name: "rsi", dir: -1, weight: 1.0 });
    else if (rsi > 70)                  signals.push({ name: "rsi", dir: 1,  weight: 0.5 }); // sobrecomprado sem slope
    else if (rsi < 30)                  signals.push({ name: "rsi", dir: -1, weight: 0.5 }); // sobrevendido sem slope
    else                                signals.push({ name: "rsi", dir: 0,  weight: 1.0 });
  }

  // ── 3. MACD histograma expandindo ─────────────────────────────────────────
  // Histograma verde E crescendo = momentum real; bearish expanding = sell.
  if (macd !== null) {
    const expandBull = macd.hist > 0 && macd.histDelta !== null && macd.histDelta > 0;
    const expandBear = macd.hist < 0 && macd.histDelta !== null && macd.histDelta < 0;
    const weakBull   = macd.hist > 0 && (macd.histDelta === null || macd.histDelta <= 0);
    const weakBear   = macd.hist < 0 && (macd.histDelta === null || macd.histDelta >= 0);

    if (expandBull)      signals.push({ name: "macd", dir: 1,    weight: 1.2 });
    else if (expandBear) signals.push({ name: "macd", dir: -1,   weight: 1.2 });
    else if (weakBull)   signals.push({ name: "macd", dir: 0.4,  weight: 0.8 }); // sem convicção
    else if (weakBear)   signals.push({ name: "macd", dir: -0.4, weight: 0.8 });
    else                 signals.push({ name: "macd", dir: 0,    weight: 1.0 });
  }

  // ── 4. Heiken Ashi 1m ─────────────────────────────────────────────────────
  // Peso cresce com número de candles consecutivos (até 3).
  if (heikenColor !== null) {
    const strength = Math.min(heikenCount, 3) / 3; // 0.33 → 0.67 → 1.0
    if (heikenColor === "green")     signals.push({ name: "ha1m", dir: 1,  weight: 1.0 * strength + 0.2 });
    else if (heikenColor === "red")  signals.push({ name: "ha1m", dir: -1, weight: 1.0 * strength + 0.2 });
    else                             signals.push({ name: "ha1m", dir: 0,  weight: 0.5 });
  }

  // ── 5. Heiken Ashi 5m (multi-timeframe) ────────────────────────────────────
  // Confirmação de prazo maior — alto valor quando concorda com 1m.
  if (heikenColor5m !== null) {
    const str5 = Math.min(heikenCount5m ?? 1, 3) / 3;
    if (heikenColor5m === "green")    signals.push({ name: "ha5m", dir: 1,  weight: 1.3 * str5 + 0.3 });
    else if (heikenColor5m === "red") signals.push({ name: "ha5m", dir: -1, weight: 1.3 * str5 + 0.3 });
    else                              signals.push({ name: "ha5m", dir: 0,  weight: 0.5 });
  }

  // ── 6. Preço em relação ao "preço a superar" ───────────────────────────────
  // Este é o fator mais relevante: a mercado só resolve UP se o preço atual > strike.
  // Distância importa — quanto mais longe, mais confiante o sinal.
  if (priceToBeat !== null && price !== null && Number.isFinite(priceToBeat) && priceToBeat > 0) {
    const dist = (price - priceToBeat) / priceToBeat; // positivo = acima do strike
    if (dist > 0.003)       signals.push({ name: "ptb", dir: 1,  weight: 2.0 }); // >0.3% acima → UP forte
    else if (dist > 0.001)  signals.push({ name: "ptb", dir: 1,  weight: 1.0 }); // 0.1–0.3% acima
    else if (dist < -0.003) signals.push({ name: "ptb", dir: -1, weight: 2.0 }); // >0.3% abaixo → DOWN forte
    else if (dist < -0.001) signals.push({ name: "ptb", dir: -1, weight: 1.0 }); // 0.1–0.3% abaixo
    else                    signals.push({ name: "ptb", dir: 0,  weight: 1.5 }); // muito próximo: neutro
  }

  // ── 7. Volume (confirmação de participação) ────────────────────────────────
  // Volume baixo em tendência é sinal de fraqueza — reduz peso do conjunto.
  let volumeMultiplier = 1.0;
  if (volume20 !== null && volumeAvg !== null && volumeAvg > 0) {
    const ratio = volume20 / volumeAvg;
    if (ratio >= 1.3) volumeMultiplier = 1.2;      // volume alto: boost
    else if (ratio < 0.6) volumeMultiplier = 0.7;  // volume muito baixo: penalidade
  }

  // ── 8. Failed VWAP reclaim ─────────────────────────────────────────────────
  // Preço tentou recuperar a VWAP mas falhou → sinal bearish forte.
  if (failedVwapReclaim === true) {
    signals.push({ name: "vwap_fail", dir: -1, weight: 1.8 });
  }

  return { signals, volumeMultiplier };
}

/**
 * Calcula o score de confluência normalizado (-1 a +1) e conta sinais concordantes.
 */
function computeConfluence(signals, volumeMultiplier, regime) {
  let weightedSum = 0;
  let totalWeight = 0;
  let bullCount = 0;
  let bearCount = 0;

  // No regime TREND, dobra o peso de VWAP e HA; no RANGE, prefere RSI e MACD.
  const regimeBoost = (name) => {
    if (regime === "TREND_UP" || regime === "TREND_DOWN") {
      if (name === "vwap" || name === "ha1m" || name === "ha5m") return 1.4;
    }
    if (regime === "RANGE") {
      if (name === "rsi" || name === "macd") return 1.3;
    }
    return 1.0;
  };

  for (const s of signals) {
    const boost = regimeBoost(s.name);
    const w = s.weight * boost * volumeMultiplier;
    weightedSum += s.dir * w;
    totalWeight += w;
    if (s.dir > 0.3)  bullCount++;
    if (s.dir < -0.3) bearCount++;
  }

  const score = totalWeight > 0 ? clamp(weightedSum / totalWeight, -1, 1) : 0;
  return { score, bullCount, bearCount, totalSignals: signals.length };
}

/**
 * Converte score de confluência em probabilidades up/down.
 * Score = 0 → 50/50. Score = +1 → ~75% UP. Score = -1 → ~75% DOWN.
 */
function scoreToProbabilities(score) {
  // Mapeamento não-linear: score extremo não deve dar 100%
  // pois há sempre incerteza no mercado de curto prazo.
  const intensity = Math.pow(Math.abs(score), 0.8); // suaviza extremos
  const halfRange = 0.25 * intensity;               // máx ±25% de desvio do 50%

  const rawUp = 0.5 + Math.sign(score) * halfRange;
  return {
    rawUp: clamp(rawUp, 0.25, 0.75),
    rawDown: clamp(1 - rawUp, 0.25, 0.75)
  };
}

/**
 * Ponto de entrada principal — substitui a função scoreDirection original.
 * Agora aceita dados de 5m e priceToBeat.
 *
 * @param {Object} inputs
 * @param {number|null} inputs.price           - Preço atual
 * @param {number|null} inputs.vwap            - VWAP da sessão
 * @param {number|null} inputs.vwapSlope       - Slope da VWAP
 * @param {number|null} inputs.rsi             - RSI (14)
 * @param {number|null} inputs.rsiSlope        - Slope do RSI
 * @param {Object|null} inputs.macd            - { hist, histDelta, macd }
 * @param {string|null} inputs.heikenColor     - "green" | "red" (1m)
 * @param {number}      inputs.heikenCount     - Candles consecutivos (1m)
 * @param {string|null} inputs.heikenColor5m   - "green" | "red" (5m)
 * @param {number}      inputs.heikenCount5m   - Candles consecutivos (5m)
 * @param {boolean}     inputs.failedVwapReclaim
 * @param {number|null} inputs.priceToBeat     - Preço a superar (do mercado Polymarket)
 * @param {number|null} inputs.volume20        - Volume dos últimos 20 candles
 * @param {number|null} inputs.volumeAvg       - Volume médio de referência
 * @param {string}      inputs.regime          - "TREND_UP" | "TREND_DOWN" | "RANGE" | "CHOP"
 *
 * @returns {{ rawUp, score, bullCount, bearCount, signalDetails }}
 */
export function scoreDirection(inputs) {
  const { signals, volumeMultiplier } = evalSignals(inputs);
  const { score, bullCount, bearCount, totalSignals } = computeConfluence(
    signals,
    volumeMultiplier,
    inputs.regime ?? "RANGE"
  );

  const { rawUp } = scoreToProbabilities(score);

  // Expõe detalhes para debug/display
  const signalDetails = signals.map((s) => ({
    name: s.name,
    direction: s.dir > 0.3 ? "UP" : s.dir < -0.3 ? "DOWN" : "NEUTRO",
    raw: s.dir
  }));

  return {
    rawUp,
    score,         // -1 a +1; use para o display "viés"
    bullCount,     // quantos sinais apontam UP
    bearCount,     // quantos sinais apontam DOWN
    totalSignals,
    signalDetails
  };
}

/**
 * Aplica decaimento temporal.
 * Quanto menos tempo sobrar, o modelo converge para 50/50
 * (mercado já formou preço — edge diminui).
 *
 * Melhoria: curva não-linear. Nos primeiros 5 minutos o decaimento é suave;
 * nos últimos 2 minutos é agressivo.
 */
export function applyTimeAwareness(rawUp, remainingMinutes, windowMinutes) {
  const t = clamp(remainingMinutes / windowMinutes, 0, 1); // 0 = expirado, 1 = início
  // Curva: mantém força até ~1/3 do tempo restante, depois decai mais rápido
  const timeDecay = t < 0.15
    ? Math.pow(t / 0.15, 2) * 0.4           // últimos 15%: decaimento quadrático forte
    : 0.4 + (t - 0.15) * (0.6 / 0.85);      // restante: linear até 1.0

  const adjustedUp = clamp(0.5 + (rawUp - 0.5) * timeDecay, 0, 1);
  return { timeDecay, adjustedUp, adjustedDown: 1 - adjustedUp };
}