import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { ensureDir } from "./utils.js";

const DEFAULT_EXCEL_FILE = "./logs/entradas.xlsx";
const DEFAULT_SHEET = "Entradas";
const DEFAULT_PARAMS_SHEET = "Parametros";

const ENTRY_COLUMNS = [
  "data",
  "dia",
  "mes",
  "ano",
  "hora",
  "janela_hora",
  "strike_inicial",
  "entrada_usd",
  "indice_entrada",
  "indice_final",
  "preco_token_final",
  "compra_venda",
  "resultado",
  "lado",
  "edge",
  "model_prob",
  "score",
  "sinais",
  "fase",
  "market_slug",
  "candle_inicio",
  "candle_fim"
];

const PARAMS_COLUMNS = [
  "timestamp",
  "fase",
  "edge_min",
  "prob_min",
  "conf_min",
  "sinais_min",
  "trades",
  "win_rate",
  "net_pnl"
];

const WIN_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC6EFCE" } };
const LOSS_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFC7CE" } };

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatWindowLabel(startMs, endMs) {
  const start = new Date(startMs);
  const end = new Date(endMs);
  return `${pad2(start.getHours())}:${pad2(start.getMinutes())} a ${pad2(end.getHours())}:${pad2(end.getMinutes())}`;
}

function dateParts(ms) {
  const d = new Date(ms);
  return {
    data: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    dia: d.getDate(),
    mes: d.getMonth() + 1,
    ano: d.getFullYear(),
    hora: pad2(d.getHours())
  };
}

async function loadWorkbook(filePath) {
  const workbook = new ExcelJS.Workbook();
  if (fs.existsSync(filePath)) {
    await workbook.xlsx.readFile(filePath);
  }
  return workbook;
}

function ensureSheet(workbook, sheetName, columns) {
  let sheet = workbook.getWorksheet(sheetName);
  if (!sheet) {
    sheet = workbook.addWorksheet(sheetName);
    sheet.addRow(columns);
    sheet.getRow(1).font = { bold: true };
    sheet.columns = columns.map((key) => ({ key, width: Math.max(12, key.length + 2) }));
  }
  return sheet;
}

async function appendEntryRows(filePath, rows) {
  if (!rows.length) return;
  ensureDir(path.dirname(filePath));
  const workbook = await loadWorkbook(filePath);
  const sheet = ensureSheet(workbook, DEFAULT_SHEET, ENTRY_COLUMNS);

  for (const row of rows) {
    const excelRow = sheet.addRow(row);
    const result = String(row.resultado || "").toUpperCase();
    const fill = result === "GANHO" ? WIN_FILL : result === "PERDA" ? LOSS_FILL : null;
    if (fill) {
      excelRow.eachCell((cell) => {
        cell.fill = fill;
      });
    }
  }

  await workbook.xlsx.writeFile(filePath);
}

async function appendParamRows(filePath, rows) {
  if (!rows.length) return;
  ensureDir(path.dirname(filePath));
  const workbook = await loadWorkbook(filePath);
  const sheet = ensureSheet(workbook, DEFAULT_PARAMS_SHEET, PARAMS_COLUMNS);
  for (const row of rows) sheet.addRow(row);
  await workbook.xlsx.writeFile(filePath);
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

function scoreTrade(trade) {
  const sign = trade.side === "UP" ? 1 : -1;
  const delta = trade.closePrice - trade.entryPrice;
  return sign * delta;
}

function suggestBestParams(trades, minTrades) {
  const edgeMins = [0.04, 0.06, 0.08, 0.1, 0.12, 0.15, 0.2];
  const probMins = [0.52, 0.55, 0.58, 0.6, 0.62, 0.65];
  const confMins = [0.4, 0.5, 0.6, 0.65, 0.7];
  const sinaisMins = [2, 3, 4, 5];

  let best = null;

  for (const edgeMin of edgeMins) {
    for (const probMin of probMins) {
      for (const confMin of confMins) {
        for (const sinaisMin of sinaisMins) {
          const selected = trades.filter((t) => (
            t.edge >= edgeMin &&
            t.modelProb >= probMin &&
            Math.abs(t.score) >= confMin &&
            t.signals >= sinaisMin
          ));

          if (selected.length < minTrades) continue;

          const wins = selected.filter((t) => t.win).length;
          const winRate = wins / selected.length;
          const netPnl = selected.reduce((acc, t) => acc + t.pnl, 0);

          const candidate = { edgeMin, probMin, confMin, sinaisMin, trades: selected.length, winRate, netPnl };

          if (!best) {
            best = candidate;
            continue;
          }

          if (candidate.winRate > best.winRate + 0.01) {
            best = candidate;
            continue;
          }

          if (Math.abs(candidate.winRate - best.winRate) <= 0.01) {
            if (candidate.netPnl > best.netPnl) {
              best = candidate;
              continue;
            }
            if (candidate.netPnl === best.netPnl && candidate.trades > best.trades) {
              best = candidate;
            }
          }
        }
      }
    }
  }

  return best;
}

export function createTradeJournal({
  filePath = DEFAULT_EXCEL_FILE,
  entryAmountUsd = 1
} = {}) {
  const openByWindow = new Map();
  const closedTrades = [];
  let lastParamsTradeCount = 0;

  function openEntry({
    windowStartMs,
    windowEndMs,
    entryPrice,
    strikeAtOpen,
    side,
    edge,
    modelProb,
    score,
    signals,
    phase,
    marketSlug
  }) {
    if (!Number.isFinite(windowEndMs)) return;
    if (openByWindow.has(windowEndMs)) return;
    if (!Number.isFinite(entryPrice)) return;

    openByWindow.set(windowEndMs, {
      windowStartMs,
      windowEndMs,
      entryPrice,
      strikeAtOpen: Number.isFinite(strikeAtOpen) ? strikeAtOpen : null,
      side,
      edge: Number.isFinite(edge) ? edge : null,
      modelProb: Number.isFinite(modelProb) ? modelProb : null,
      score: Number.isFinite(score) ? score : null,
      signals: Number.isFinite(signals) ? signals : null,
      phase: phase ?? "-",
      marketSlug: marketSlug ?? ""
    });
  }

  async function closeWindow({ windowEndMs, candles, fallbackPrice, outcomePrices }) {
    if (!openByWindow.has(windowEndMs)) return [];
    const entry = openByWindow.get(windowEndMs);
    openByWindow.delete(windowEndMs);

    let tokenClose = null;
    if (outcomePrices && entry.side === "UP" && Number.isFinite(outcomePrices.up)) {
      tokenClose = outcomePrices.up;
    } else if (outcomePrices && entry.side === "DOWN" && Number.isFinite(outcomePrices.down)) {
      tokenClose = outcomePrices.down;
    }

    const btcClose = pickClosePrice(candles, windowEndMs) ?? (Number.isFinite(fallbackPrice) ? fallbackPrice : null);
    if (!Number.isFinite(btcClose)) return [];

    const strike = Number.isFinite(entry.strikeAtOpen) ? entry.strikeAtOpen : null;
    const win = strike !== null
      ? (entry.side === "UP" ? btcClose > strike : btcClose < strike)
      : false;
    const pnl = win ? 1 : -1;

    const parts = dateParts(entry.windowStartMs);
    const row = {
      data: parts.data,
      dia: parts.dia,
      mes: parts.mes,
      ano: parts.ano,
      hora: parts.hora,
      janela_hora: formatWindowLabel(entry.windowStartMs, entry.windowEndMs),
      strike_inicial: entry.strikeAtOpen,
      entrada_usd: entryAmountUsd,
      indice_entrada: entry.entryPrice,
      indice_final: btcClose,
      preco_token_final: tokenClose,
      compra_venda: entry.side === "UP" ? "COMPRA" : "VENDA",
      resultado: win ? "GANHO" : "PERDA",
      lado: entry.side,
      edge: entry.edge,
      model_prob: entry.modelProb,
      score: entry.score,
      sinais: entry.signals,
      fase: entry.phase,
      market_slug: entry.marketSlug,
      candle_inicio: new Date(entry.windowStartMs).toISOString(),
      candle_fim: new Date(entry.windowEndMs).toISOString()
    };

    void appendEntryRows(filePath, [row]);

    const trade = {
      edge: entry.edge ?? 0,
      modelProb: entry.modelProb ?? 0,
      score: entry.score ?? 0,
      signals: entry.signals ?? 0,
      phase: entry.phase ?? "-",
      win,
      pnl
    };
    closedTrades.push(trade);

    return [trade];
  }

  function maybeSuggestParams() {
    if (closedTrades.length < 20) return null;
    if (closedTrades.length - lastParamsTradeCount < 10) return null;

    const phases = Array.from(new Set(closedTrades.map((t) => t.phase)));
    const rows = [];

    for (const phase of phases) {
      const subset = closedTrades.filter((t) => t.phase === phase);
      if (subset.length < 10) continue;

      const best = suggestBestParams(subset, 8) ?? suggestBestParams(subset, 5);
      if (!best) continue;

      rows.push({
        timestamp: new Date().toISOString(),
        fase: phase,
        edge_min: best.edgeMin,
        prob_min: best.probMin,
        conf_min: best.confMin,
        sinais_min: best.sinaisMin,
        trades: best.trades,
        win_rate: Number.isFinite(best.winRate) ? best.winRate : null,
        net_pnl: Number.isFinite(best.netPnl) ? best.netPnl : null
      });
    }

    if (!rows.length) return null;

    void appendParamRows(filePath, rows);
    lastParamsTradeCount = closedTrades.length;
    return rows;
  }

  return {
    openEntry,
    closeWindow,
    maybeSuggestParams
  };
}
