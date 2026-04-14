import { learningState } from "./learningState.js";

export function updateLearning({ trade }) {
  const {
    evExpected,
    result, // +1 win, -1 loss
    pnl // lucro real ($)
  } = trade;

  const stats = learningState.stats;

  stats.totalTrades++;
  stats.totalEV += evExpected;
  stats.realPnL += pnl;

  if (result > 0) stats.wins++;
  else stats.losses++;

  // só começa a ajustar após 20 trades
  if (stats.totalTrades < 20) return;

  const winRate = stats.wins / stats.totalTrades;
  const avgEV = stats.totalEV / stats.totalTrades;

  // ========================
  // AJUSTE DE EDGE
  // ========================
  if (winRate < 0.5) {
    learningState.edgeMin += 0.01; // mais seletivo
  } else if (winRate > 0.60) {
    learningState.edgeMin -= 0.01; // mais agressivo
  }

  learningState.edgeMin = clamp(learningState.edgeMin, 0.08, 0.20);

  // ========================
  // AJUSTE DE DELTA
  // ========================
  if (stats.realPnL < 0) {
    learningState.deltaMin.LATE += 5;
    learningState.deltaMin.FINAL += 10;
  } else {
    learningState.deltaMin.LATE -= 5;
    learningState.deltaMin.FINAL -= 10;
  }

  // limites
  learningState.deltaMin.LATE = clamp(learningState.deltaMin.LATE, 60, 150);
  learningState.deltaMin.FINAL = clamp(learningState.deltaMin.FINAL, 80, 200);

  // ========================
  // AJUSTE DE SCORE
  // ========================
  if (winRate < 0.45) {
    learningState.scoreMin.MID += 0.02;
  } else if (winRate > 0.60) {
    learningState.scoreMin.MID -= 0.02;
  }

  learningState.scoreMin.MID = clamp(learningState.scoreMin.MID, 0.15, 0.40);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}