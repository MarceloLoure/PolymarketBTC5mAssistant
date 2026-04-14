import { learningState } from "./learningState.js";

export function polymarketDecisionEngine(input) {
  const {
    timeLeftMin,
    score,
    bullCount,
    bearCount,
    marketUp,
    marketDown,
    modelUp,
    modelDown,
    currentPrice,
    priceToBeat
  } = input;

  // ========================
  // 1. VALIDAÇÃO
  // ========================
  if (
    timeLeftMin == null ||
    currentPrice == null ||
    priceToBeat == null ||
    marketUp == null ||
    marketDown == null
  ) {
    return { action: "NO_TRADE", reason: "DADOS INSUFICIENTES" };
  }

  // ========================
  // 2. FASE
  // ========================
  let phase = "EARLY";
  if (timeLeftMin > 3) phase = "EARLY";
  else if (timeLeftMin > 1) phase = "MID";
  else if (timeLeftMin > 0.166) phase = "LATE";
  else phase = "FINAL";

  // ========================
  // 3. DELTA
  // ========================
  const delta = currentPrice - priceToBeat;
  const absDelta = Math.abs(delta);

  const direction = delta > 0 ? "UP" : "DOWN";

  // ========================
  // 4. PROBABILIDADE
  // ========================
  let probUp = modelUp;
  let probDown = modelDown;

  if (!probUp || !probDown) {
    let prob = 0;

    if (absDelta > 200) prob = 0.65;
    else if (absDelta > 100) prob = 0.60;
    else if (absDelta > 50) prob = 0.55;
    else return { action: "NO_TRADE", reason: "DELTA MUITO PEQUENO" };

    probUp = delta > 0 ? prob : 1 - prob;
    probDown = delta < 0 ? prob : 1 - prob;
  }

  // ========================
  // 5. EDGE
  // ========================
  const EDGE_MIN = learningState.edgeMin;

  const edgeUp = probUp - marketUp;
  const edgeDown = probDown - marketDown;

  const edgeUpLiq = edgeUp - EDGE_MIN;
  const edgeDownLiq = edgeDown - EDGE_MIN;

  // ========================
  // 6. BLOQUEIOS
  // ========================

  // preço alto
  if (marketUp > 0.85 || marketDown > 0.85) {
    return { action: "NO_TRADE", reason: "PRECO MUITO ALTO" };
  }

  // delta mínimo
  if (absDelta < 30) {
    return { action: "NO_TRADE", reason: "DELTA BAIXO" };
  }

  // edge mínimo
  if (edgeUpLiq < EDGE_MIN && edgeDownLiq < EDGE_MIN) {
    return { action: "NO_TRADE", reason: "SEM EDGE >=10%" };
  }

  // score vs sinais
  if (score > 0 && bearCount > bullCount) {
    return { action: "NO_TRADE", reason: "CONFLITO SINAIS" };
  }
  if (score < 0 && bullCount > bearCount) {
    return { action: "NO_TRADE", reason: "CONFLITO SINAIS" };
  }

  // ========================
  // 7. BLOQUEIOS POR FASE
  // ========================
  if (phase === "EARLY") {
    if (Math.abs(score) < 0.20 || (bullCount < 2 && bearCount < 2)) {
      return { action: "NO_TRADE", reason: "EARLY FRACO" };
    }
  }

  if (phase === "MID") {
    if (Math.abs(score) < 0.25 || (bullCount < 3 && bearCount < 3) || absDelta < 50) {
      return { action: "NO_TRADE", reason: "MID FRACO" };
    }
  }

  if (phase === "LATE") {
    if (absDelta < learningState.deltaMin.LATE){
      return { action: "NO_TRADE", reason: "LATE DELTA BAIXO" };
    }
  }

  if (phase === "FINAL") {
    if (absDelta < 120 || marketUp > 0.80 || marketDown > 0.80) {
      return { action: "NO_TRADE", reason: "FINAL RUIM" };
    }
  }

  // ========================
  // 8. ESCOLHA DO LADO
  // ========================
  let side = null;
  let edge = 0;
  let prob = 0;
  let price = 0;

  if (direction === "UP") {
    side = edgeUpLiq > edgeDownLiq ? "UP" : "DOWN";
  } else {
    side = edgeDownLiq > edgeUpLiq ? "DOWN" : "UP";
  }

  if (side === "UP") {
    edge = edgeUpLiq;
    prob = probUp;
    price = marketUp;
  } else {
    edge = edgeDownLiq;
    prob = probDown;
    price = marketDown;
  }

  // ========================
  // 9. EXPECTED VALUE
  // ========================
  const shares = 1 / price;
  const profit = shares - 1;

  const EV = (prob * profit) - ((1 - prob) * 1);

  if (EV < 0.01) {
    return { action: "NO_TRADE", reason: "EV BAIXO" };
  }

  // ========================
  // 10. RESULTADO
  // ========================
  return {
    action: "ENTER",
    side,
    phase,
    edge,
    ev: EV,
    prob,
    price,
    delta
  };
}