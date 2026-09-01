/**
 * Smith Backtest Engine (JS)
 * ===========================
 * Puerto a JavaScript puro del motor de backtesting (backtest_engine.py).
 * Corre 100% en el navegador, sin backend — pensado para una pagina
 * estatica (GitHub Pages) que funcione igual en cualquier dispositivo.
 *
 * Matematicamente identico al original en Python: misma logica de
 * indicadores, mismo esquema setup->confirmacion, misma simulacion de
 * capital. Validado por paridad numerica contra backtest_engine.py.
 */

// ---------------------------------------------------------------------------
// 1. Indicadores tecnicos
// ---------------------------------------------------------------------------

function sma(values, period) {
  const out = new Array(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    let hasNaN = false;
    for (let j = i - period + 1; j <= i; j++) {
      if (Number.isNaN(values[j])) { hasNaN = true; break; }
      sum += values[j];
    }
    out[i] = hasNaN ? NaN : sum / period;
  }
  return out;
}

// Desviacion estandar muestral (ddof=1), como pandas .rolling().std()
function rollingStd(values, period) {
  const out = new Array(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    const mean = sum / period;
    let sqSum = 0;
    for (let j = i - period + 1; j <= i; j++) sqSum += (values[j] - mean) ** 2;
    out[i] = Math.sqrt(sqSum / (period - 1));
  }
  return out;
}

function ema(values, period) {
  const out = new Array(values.length).fill(NaN);
  const alpha = 2 / (period + 1);
  out[0] = values[0];
  for (let i = 1; i < values.length; i++) {
    out[i] = alpha * values[i] + (1 - alpha) * out[i - 1];
  }
  return out;
}

function bollingerBands(closes, period, stdMult) {
  const mid = sma(closes, period);
  const std = rollingStd(closes, period);
  const upper = mid.map((m, i) => m + stdMult * std[i]);
  const lower = mid.map((m, i) => m - stdMult * std[i]);
  return { upper, mid, lower };
}

function rollingMin(values, period) {
  const out = new Array(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i++) {
    let min = Infinity;
    for (let j = i - period + 1; j <= i; j++) if (values[j] < min) min = values[j];
    out[i] = min;
  }
  return out;
}

function rollingMax(values, period) {
  const out = new Array(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i++) {
    let max = -Infinity;
    for (let j = i - period + 1; j <= i; j++) if (values[j] > max) max = values[j];
    out[i] = max;
  }
  return out;
}

function stochastic(candles, kPeriod, dPeriod, smooth) {
  const lows = candles.map((c) => c.low);
  const highs = candles.map((c) => c.high);
  const closes = candles.map((c) => c.close);
  const lowMin = rollingMin(lows, kPeriod);
  const highMax = rollingMax(highs, kPeriod);
  const rawK = closes.map((c, i) => (100 * (c - lowMin[i])) / (highMax[i] - lowMin[i]));
  const k = sma(rawK, smooth);
  const d = sma(k, dPeriod);
  return { k, d };
}

// RSI de Wilder (EMA de ganancias/perdidas con alpha=1/period, adjust=False)
function rsi(closes, period) {
  const n = closes.length;
  const alpha = 1 / period;
  const avgGain = new Array(n).fill(NaN);
  const avgLoss = new Array(n).fill(NaN);
  // El primer delta (indice 0) no existe, igual que pandas .diff().
  // El primer valor valido (indice 1) es la semilla del EWM, no se promedia con nada anterior.
  for (let i = 1; i < n; i++) {
    const delta = closes[i] - closes[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    if (i === 1) {
      avgGain[i] = gain;
      avgLoss[i] = loss;
    } else {
      avgGain[i] = alpha * gain + (1 - alpha) * avgGain[i - 1];
      avgLoss[i] = alpha * loss + (1 - alpha) * avgLoss[i - 1];
    }
  }
  return avgGain.map((g, i) => {
    const rs = g / avgLoss[i];
    return 100 - 100 / (1 + rs);
  });
}

function cci(candles, period) {
  const tp = candles.map((c) => (c.high + c.low + c.close) / 3);
  const tpSma = sma(tp, period);
  const meanDev = new Array(tp.length).fill(NaN);
  for (let i = period - 1; i < tp.length; i++) {
    const mean = tpSma[i];
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += Math.abs(tp[j] - mean);
    meanDev[i] = sum / period;
  }
  return tp.map((t, i) => (t - tpSma[i]) / (0.015 * meanDev[i]));
}

// ---------------------------------------------------------------------------
// 2. Configuracion de la estrategia (default = igual a StrategyConfig de Python)
// ---------------------------------------------------------------------------

function defaultStrategyConfig() {
  return {
    bb_enabled: true, bb_period: 20, bb_std: 2.0,
    rsi_enabled: false, rsi_period: 14, rsi_oversold: 30, rsi_overbought: 70,
    cci_enabled: false, cci_period: 20, cci_oversold: -100, cci_overbought: 100,
    stoch_enabled: true, stoch_k: 14, stoch_d: 3, stoch_smooth: 3, stoch_oversold: 20, stoch_overbought: 80,
    ma_enabled: true, ma_type: "ema", ma_period: 8,
    confirm_window: 3,
    schedule_days: [0, 1, 2, 3, 4, 5, 6],  // 0=lunes ... 6=domingo
    schedule_start: "00:00",
    schedule_end: "23:59",
  };
}

function requiredWarmup(cfg) {
  const periods = [cfg.confirm_window + 2];
  if (cfg.bb_enabled) periods.push(cfg.bb_period);
  if (cfg.rsi_enabled) periods.push(cfg.rsi_period);
  if (cfg.cci_enabled) periods.push(cfg.cci_period);
  if (cfg.stoch_enabled) periods.push(cfg.stoch_k + cfg.stoch_smooth + cfg.stoch_d);
  if (cfg.ma_enabled) periods.push(cfg.ma_period);
  return Math.max(...periods);
}

function generateSignals(candles, cfg) {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const signals = new Array(n).fill(null);

  let setupCall = new Array(n).fill(true);
  let setupPut = new Array(n).fill(true);
  let anyExtreme = false;

  let bb = null, rsiVals = null, cciVals = null, stoch = null;

  if (cfg.bb_enabled) {
    anyExtreme = true;
    bb = bollingerBands(closes, cfg.bb_period, cfg.bb_std);
    for (let i = 0; i < n; i++) {
      setupCall[i] = setupCall[i] && closes[i] <= bb.lower[i];
      setupPut[i] = setupPut[i] && closes[i] >= bb.upper[i];
    }
  }
  if (cfg.rsi_enabled) {
    anyExtreme = true;
    rsiVals = rsi(closes, cfg.rsi_period);
    for (let i = 0; i < n; i++) {
      setupCall[i] = setupCall[i] && rsiVals[i] < cfg.rsi_oversold;
      setupPut[i] = setupPut[i] && rsiVals[i] > cfg.rsi_overbought;
    }
  }
  if (cfg.cci_enabled) {
    anyExtreme = true;
    cciVals = cci(candles, cfg.cci_period);
    for (let i = 0; i < n; i++) {
      setupCall[i] = setupCall[i] && cciVals[i] < cfg.cci_oversold;
      setupPut[i] = setupPut[i] && cciVals[i] > cfg.cci_overbought;
    }
  }
  if (cfg.stoch_enabled) {
    anyExtreme = true;
    stoch = stochastic(candles, cfg.stoch_k, cfg.stoch_d, cfg.stoch_smooth);
    for (let i = 0; i < n; i++) {
      setupCall[i] = setupCall[i] && stoch.k[i] < cfg.stoch_oversold;
      setupPut[i] = setupPut[i] && stoch.k[i] > cfg.stoch_overbought;
    }
  }

  if (!anyExtreme) {
    throw new Error(
      "Necesitas tener activado al menos un indicador de extremo (Bollinger, RSI, CCI o Estocastico) para poder detectar entradas."
    );
  }

  // limpiar NaN -> false (equivalente a fillna(False) en pandas)
  setupCall = setupCall.map((v, i) => (isSetupNaN(i) ? false : v));
  setupPut = setupPut.map((v, i) => (isSetupNaN(i) ? false : v));
  function isSetupNaN(i) {
    if (cfg.bb_enabled && (Number.isNaN(bb.lower[i]) || Number.isNaN(bb.upper[i]))) return true;
    if (cfg.rsi_enabled && Number.isNaN(rsiVals[i])) return true;
    if (cfg.cci_enabled && Number.isNaN(cciVals[i])) return true;
    if (cfg.stoch_enabled && Number.isNaN(stoch.k[i])) return true;
    return false;
  }

  // ---- confirmacion ----
  let confirmCall = new Array(n).fill(true);
  let confirmPut = new Array(n).fill(true);
  let anyConfirm = false;

  if (cfg.stoch_enabled) {
    anyConfirm = true;
    for (let i = 0; i < n; i++) {
      const crossUp = i > 0 && stoch.k[i] > stoch.d[i] && stoch.k[i - 1] <= stoch.d[i - 1];
      const crossDown = i > 0 && stoch.k[i] < stoch.d[i] && stoch.k[i - 1] >= stoch.d[i - 1];
      confirmCall[i] = confirmCall[i] && crossUp;
      confirmPut[i] = confirmPut[i] && crossDown;
    }
  }
  if (cfg.ma_enabled) {
    anyConfirm = true;
    const maFunc = cfg.ma_type === "sma" ? sma : ema;
    const ma = maFunc(closes, cfg.ma_period);
    for (let i = 0; i < n; i++) {
      const slope = i > 0 ? ma[i] - ma[i - 1] : NaN;
      confirmCall[i] = confirmCall[i] && slope > 0;
      confirmPut[i] = confirmPut[i] && slope < 0;
    }
  }
  confirmCall = confirmCall.map((v) => (Number.isNaN(v) ? false : !!v));
  confirmPut = confirmPut.map((v) => (Number.isNaN(v) ? false : !!v));

  if (!anyConfirm) {
    for (let i = 0; i < n; i++) {
      if (setupCall[i]) signals[i] = "CALL";
      if (setupPut[i]) signals[i] = "PUT";
    }
    return applyScheduleFilter(signals, candles, cfg);
  }

  for (let i = 0; i < n; i++) {
    if (setupCall[i]) {
      const end = Math.min(i + cfg.confirm_window, n);
      for (let j = i; j < end; j++) {
        if (confirmCall[j]) { signals[j] = "CALL"; break; }
      }
    }
  }
  for (let i = 0; i < n; i++) {
    if (setupPut[i]) {
      const end = Math.min(i + cfg.confirm_window, n);
      for (let j = i; j < end; j++) {
        if (confirmPut[j]) { signals[j] = "PUT"; break; }
      }
    }
  }

  return applyScheduleFilter(signals, candles, cfg);
}

// Anula (null) cualquier senal fuera de los dias/horario configurados.
// Mismo comportamiento que apply_schedule_filter() en Python: 0=lunes.
function applyScheduleFilter(signals, candles, cfg) {
  const allDays = [0, 1, 2, 3, 4, 5, 6];
  const days = cfg.schedule_days || allDays;
  const start = cfg.schedule_start || "00:00";
  const end = cfg.schedule_end || "23:59";
  if (allDays.every((d) => days.includes(d)) && start === "00:00" && end === "23:59") {
    return signals; // caso comun: sin filtro, no gastamos tiempo de mas
  }

  const [startH, startM] = start.split(":").map(Number);
  const [endH, endM] = end.split(":").map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  for (let i = 0; i < signals.length; i++) {
    if (signals[i] === null) continue;
    const ts = String(candles[i].timestamp);
    const [datePart, timePart] = ts.split(/[ T]/);
    const [y, mo, d] = datePart.split("-").map(Number);
    const jsDay = new Date(Date.UTC(y, mo - 1, d)).getUTCDay(); // 0=domingo
    const weekday = (jsDay + 6) % 7; // convertido a 0=lunes, igual que Python

    let minutesOfDay = 0;
    if (timePart) {
      const [hh, mm] = timePart.split(":").map(Number);
      minutesOfDay = hh * 60 + mm;
    }

    const dayOk = days.includes(weekday);
    const timeOk = startMinutes <= endMinutes
      ? minutesOfDay >= startMinutes && minutesOfDay <= endMinutes
      : minutesOfDay >= startMinutes || minutesOfDay <= endMinutes;

    if (!dayOk || !timeOk) signals[i] = null;
  }

  return signals;
}

// ---------------------------------------------------------------------------
// 3. Gestion de capital
// ---------------------------------------------------------------------------

function defaultMoneyManagement() {
  return {
    initial_capital: 1000, stake_mode: "percent", stake_value: 2, payout: 0.85,
    martingale: false, martingale_multiplier: 2.0, martingale_max_steps: 2,
    max_daily_loss_pct: 20,
  };
}

function stakeFor(moneyCfg, capital, consecutiveLosses) {
  let base = moneyCfg.stake_mode === "percent" ? capital * (moneyCfg.stake_value / 100) : moneyCfg.stake_value;
  if (moneyCfg.martingale && consecutiveLosses > 0) {
    const steps = Math.min(consecutiveLosses, moneyCfg.martingale_max_steps);
    base *= moneyCfg.martingale_multiplier ** steps;
  }
  return round2(base);
}

function round2(x) { return Math.round(x * 100) / 100; }

// ---------------------------------------------------------------------------
// 4. Motor de backtesting
// ---------------------------------------------------------------------------

function runBacktest(candles, strategyCfg, moneyCfg, expiryCandles) {
  const signals = generateSignals(candles, strategyCfg);

  let capital = moneyCfg.initial_capital;
  let dayStartCapital = capital;
  let currentDay = null;
  let consecutiveLosses = 0;
  let haltedToday = false;

  const trades = [];
  const equityCurve = [capital];

  for (let i = 0; i < candles.length - expiryCandles; i++) {
    const row = candles[i];
    const day = String(row.timestamp).slice(0, 10);
    if (day !== currentDay) {
      currentDay = day;
      dayStartCapital = capital;
      haltedToday = false;
    }

    if (haltedToday || signals[i] === null) continue;

    const stake = stakeFor(moneyCfg, capital, consecutiveLosses);
    if (stake <= 0 || stake > capital) continue;

    const entryPrice = row.close;
    const exitPrice = candles[i + expiryCandles].close;
    const win = signals[i] === "CALL" ? exitPrice > entryPrice : exitPrice < entryPrice;

    let pnl;
    if (win) {
      pnl = round2(stake * moneyCfg.payout);
      consecutiveLosses = 0;
    } else {
      pnl = -stake;
      consecutiveLosses += 1;
    }
    capital += pnl;

    trades.push({
      entry_time: row.timestamp,
      direction: signals[i],
      entry_price: entryPrice,
      exit_price: exitPrice,
      stake,
      result: win ? "WIN" : "LOSS",
      pnl,
      capital_after: capital,
    });
    equityCurve.push(capital);

    if (capital <= dayStartCapital * (1 - moneyCfg.max_daily_loss_pct / 100)) {
      haltedToday = true;
    }
    if (capital <= 0) break;
  }

  return { trades, equityCurve, finalCapital: capital };
}

function summarize(result) {
  const n = result.trades.length;
  if (n === 0) return { trades: 0 };
  const wins = result.trades.filter((t) => t.result === "WIN").length;
  const losses = n - wins;
  const grossWin = result.trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = -result.trades.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0);

  let runningMax = -Infinity;
  let maxDd = 0;
  let maxDdPct = 0;
  for (const capital of result.equityCurve) {
    if (capital > runningMax) runningMax = capital;
    const dd = capital - runningMax;
    if (dd < maxDd) maxDd = dd;
    const ddPct = runningMax > 0 ? (dd / runningMax) * 100 : 0;
    if (ddPct < maxDdPct) maxDdPct = ddPct;
  }

  const netPnl = result.finalCapital - result.equityCurve[0];
  return {
    trades: n,
    wins,
    losses,
    winrate_pct: round2((100 * wins) / n),
    profit_factor: grossLoss > 0 ? round2(grossWin / grossLoss) : Infinity,
    net_pnl: round2(netPnl),
    final_capital: round2(result.finalCapital),
    max_drawdown: round2(maxDd),
    max_drawdown_pct: round2(maxDdPct),
    expectancy_per_trade: round2(netPnl / n),
  };
}

// ---------------------------------------------------------------------------
// exports (funciona tanto en <script> de navegador como en Node para testear)
// ---------------------------------------------------------------------------

const SmithEngine = {
  sma, ema, bollingerBands, stochastic, rsi, cci,
  defaultStrategyConfig, requiredWarmup, generateSignals,
  defaultMoneyManagement, stakeFor,
  runBacktest, summarize,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = SmithEngine;
} else {
  window.SmithEngine = SmithEngine;
}
