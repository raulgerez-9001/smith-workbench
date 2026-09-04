// ============================================================
// SMITH WORKBENCH (estatico) — controlador principal
// ============================================================

const $ = (id) => document.getElementById(id);
const { dbPut, dbGet, dbGetAll, dbDelete, newId } = window.SmithDB;
const Engine = window.SmithEngine;

let equityChart = null;
let lastResult = null;   // { candles, summary, equityCurve, trades }
let currentPairId = null; // id del dataset elegido

const TIMEFRAME_SECONDS = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1d": 86400 };
const TIMEFRAME_LABEL = { "1m": "1 min", "5m": "5 min", "15m": "15 min", "30m": "30 min", "1h": "1 hora", "4h": "4 horas", "1d": "1 dia" };

const STRATEGY_FIELDS = [
  "bb_enabled", "bb_period", "bb_std",
  "rsi_enabled", "rsi_period", "rsi_oversold", "rsi_overbought",
  "cci_enabled", "cci_period", "cci_oversold", "cci_overbought",
  "stoch_enabled", "stoch_k", "stoch_d", "stoch_smooth", "stoch_oversold", "stoch_overbought",
  "ma_enabled", "ma_type", "ma_period",
  "confirm_window",
];
const TOGGLE_MODULES = ["bb_enabled", "rsi_enabled", "cci_enabled", "stoch_enabled", "ma_enabled"];
const MONEY_FIELDS = ["initial_capital", "stake_mode", "stake_value", "payout", "martingale", "martingale_multiplier", "martingale_max_steps", "max_daily_loss_pct", "random_delay_enabled", "random_delay_min_sec", "random_delay_max_sec"];

// ---------------- utilidades ----------------

function toast(msg, isError = false) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 3200);
}

function fmt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return typeof n === "number" ? n.toLocaleString("es-AR", { maximumFractionDigits: 2 }) : n;
}

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("es-AR") + " " + d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
}

// ---------------- pestañas ----------------

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
    btn.classList.add("active");
    $(`tab-${btn.dataset.tab}`).classList.remove("hidden");
    if (btn.dataset.tab === "strategies") renderStrategiesList();
    if (btn.dataset.tab === "backtests") renderBacktestsList();
    if (btn.dataset.tab === "data") { renderDatasetsList(); renderServerDatasetsList(); }
  });
});

// ---------------- formulario: leer / escribir ----------------

function readStrategyConfig() {
  const cfg = {};
  for (const id of STRATEGY_FIELDS) {
    const el = $(id);
    if (el.type === "checkbox") cfg[id] = el.checked;
    else if (el.tagName === "SELECT") cfg[id] = el.value;
    else cfg[id] = Number(el.value);
  }
  cfg.schedule_days = Array.from(document.querySelectorAll(".sched-day:checked")).map((el) => Number(el.value));
  cfg.schedule_start = $("schedule_start").value || "00:00";
  cfg.schedule_end = $("schedule_end").value || "23:59";
  return cfg;
}

function writeStrategyConfig(cfg) {
  for (const [k, v] of Object.entries(cfg)) {
    const el = $(k);
    if (!el) continue;
    if (el.type === "checkbox") el.checked = !!v;
    else el.value = v;
  }
  const days = cfg.schedule_days || [0, 1, 2, 3, 4, 5, 6];
  document.querySelectorAll(".sched-day").forEach((el) => {
    el.checked = days.includes(Number(el.value));
  });
  syncModuleToggles();
}

function readMoneyConfig() {
  const cfg = {};
  for (const id of MONEY_FIELDS) {
    const el = $(id);
    if (el.type === "checkbox") cfg[id] = el.checked;
    else cfg[id] = Number(el.value);
  }
  cfg.stake_mode = $("stake_mode").value;
  return cfg;
}

function writeMoneyConfig(cfg) {
  for (const [k, v] of Object.entries(cfg)) {
    const el = $(k);
    if (!el) continue;
    if (el.type === "checkbox") el.checked = !!v;
    else el.value = v;
  }
}

function syncModuleToggles() {
  for (const toggleId of TOGGLE_MODULES) {
    const toggleEl = $(toggleId);
    const module = toggleEl.closest(".module");
    const on = toggleEl.checked;
    module.classList.toggle("disabled", !on);
    module.querySelectorAll("input:not([type=checkbox]), select").forEach((el) => (el.disabled = !on));
  }
  syncMartingaleVisibility();
  syncDelayVisibility();
  updateExpiryHint();
}
TOGGLE_MODULES.forEach((id) => $(id).addEventListener("change", syncModuleToggles));

function syncMartingaleVisibility() {
  const on = $("martingale").checked;
  document.querySelectorAll(".martingale-sub").forEach((el) => {
    el.style.opacity = on ? "1" : "0.35";
    el.querySelectorAll("input").forEach((i) => (i.disabled = !on));
  });
}
$("martingale").addEventListener("change", syncMartingaleVisibility);

function syncDelayVisibility() {
  const on = $("random_delay_enabled").checked;
  document.querySelectorAll(".delay-sub").forEach((el) => {
    el.style.opacity = on ? "1" : "0.35";
    el.querySelectorAll("input").forEach((i) => (i.disabled = !on));
  });
}
$("random_delay_enabled").addEventListener("change", syncDelayVisibility);

function updateExpiryHint() {
  const sec = currentPairId ? TIMEFRAME_SECONDS[currentPairId.split("::")[1]] : 60;
  const candles = Number($("expiry_candles").value) || 0;
  const totalMin = (candles * sec) / 60;
  $("expiryHint").textContent = totalMin ? `≈ ${totalMin} min de vencimiento` : "";
}
$("expiry_candles").addEventListener("input", updateExpiryHint);

// ---------------- datasets (pestaña Datos) ----------------

function parseCSV(text) {
  const lines = text.trim().split("\n");
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const idx = {
    timestamp: header.indexOf("timestamp"),
    open: header.indexOf("open"),
    high: header.indexOf("high"),
    low: header.indexOf("low"),
    close: header.indexOf("close"),
  };
  for (const [k, v] of Object.entries(idx)) {
    if (v === -1) throw new Error(`Falta la columna '${k}' en el CSV.`);
  }
  const candles = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = lines[i].split(",");
    candles.push({
      timestamp: cols[idx.timestamp],
      open: Number(cols[idx.open]),
      high: Number(cols[idx.high]),
      low: Number(cols[idx.low]),
      close: Number(cols[idx.close]),
    });
  }
  candles.sort((a, b) => (a.timestamp > b.timestamp ? 1 : -1));
  return candles;
}

$("dataUploadBtn").addEventListener("click", async () => {
  const pair = $("dataPairInput").value.trim().toUpperCase();
  const timeframe = $("dataTimeframeInput").value;
  const file = $("dataFileInput").files[0];
  if (!pair) { toast("Ponele un nombre al par.", true); return; }
  if (!file) { toast("Elegí un archivo CSV.", true); return; }

  try {
    const text = await file.text();
    const candles = parseCSV(text);
    const id = `${pair}::${timeframe}`;
    await dbPut("datasets", {
      id, pair, timeframe, candles,
      created_at: new Date().toISOString(),
    });
    toast(`${pair} · ${TIMEFRAME_LABEL[timeframe]}: ${candles.length} velas cargadas`);
    $("dataPairInput").value = "";
    $("dataFileInput").value = "";
    await renderDatasetsList();
    await refreshPairSelect(id);
  } catch (err) {
    toast(err.message, true);
  }
});

async function renderDatasetsList() {
  const datasets = await dbGetAll("datasets");
  const el = $("datasetsList");
  if (datasets.length === 0) {
    el.innerHTML = `<p class="muted small">Todavia no cargaste ningun par.</p>`;
    return;
  }
  datasets.sort((a, b) => a.pair.localeCompare(b.pair));
  el.innerHTML = datasets.map((d) => `
    <div class="lib-card">
      <div class="lib-card-top">
        <span class="lib-card-name">${d.pair} · ${TIMEFRAME_LABEL[d.timeframe]}</span>
        <span class="lib-card-date">${fmtDate(d.created_at)}</span>
      </div>
      <div class="lib-card-meta">
        ${d.candles.length} velas<br>
        ${d.candles[0]?.timestamp} → ${d.candles[d.candles.length - 1]?.timestamp}
      </div>
      <div class="lib-card-actions">
        <button class="danger" data-action="delete-dataset" data-id="${d.id}">Eliminar</button>
      </div>
    </div>`).join("");

  el.querySelectorAll("[data-action=delete-dataset]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("¿Eliminar este dataset?")) return;
      await dbDelete("datasets", btn.dataset.id);
      await renderDatasetsList();
      await refreshPairSelect();
    });
  });
}

async function renderServerDatasetsList() {
  const el = $("serverDatasetsList");
  if (!syncEnabled()) {
    el.innerHTML = `<p class="muted small">Configurá el servidor arriba para ver esta lista.</p>`;
    return;
  }
  let pairs;
  try {
    pairs = await backendApi("/api/pairs");
  } catch (err) {
    el.innerHTML = `<p class="muted small">No se pudo conectar al servidor: ${err.message}</p>`;
    return;
  }
  if (pairs.length === 0) {
    el.innerHTML = `<p class="muted small">Todavia no se descargó ningún par en el servidor.</p>`;
    return;
  }
  el.innerHTML = pairs.map((p) => `
    <div class="lib-card">
      <div class="lib-card-top"><span class="lib-card-name">${p.pair} · ${TIMEFRAME_LABEL[p.timeframe] || p.timeframe}</span></div>
      <div class="lib-card-meta">${p.candles} velas<br>${p.from} → ${p.to}</div>
      <div class="lib-card-actions"><button data-action="import-dataset" data-pair="${p.pair}" data-tf="${p.timeframe}">Importar a este dispositivo</button></div>
    </div>`).join("");

  el.querySelectorAll("[data-action=import-dataset]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const { pair, tf } = btn.dataset;
      btn.disabled = true;
      btn.textContent = "Importando…";
      try {
        const data = await backendApi(`/api/pairs/${encodeURIComponent(pair)}/data?timeframe=${tf}`);
        const id = `${pair}::${tf}`;
        await dbPut("datasets", { id, pair, timeframe: tf, candles: data.candles, created_at: new Date().toISOString() });
        toast(`${pair} · ${TIMEFRAME_LABEL[tf]} importado.`);
        await renderDatasetsList();
        await refreshPairSelect(id);
      } catch (err) {
        toast(err.message, true);
      } finally {
        btn.disabled = false;
        btn.textContent = "Importar a este dispositivo";
      }
    });
  });
}

async function refreshPairSelect(selectId = null) {
  const datasets = await dbGetAll("datasets");
  const sel = $("pairSelect");
  sel.innerHTML = "";
  if (datasets.length === 0) {
    sel.innerHTML = `<option value="">Sin datos — andá a la pestaña "Datos"</option>`;
    currentPairId = null;
    return;
  }
  datasets.sort((a, b) => a.pair.localeCompare(b.pair));
  for (const d of datasets) {
    const opt = document.createElement("option");
    opt.value = d.id;
    opt.textContent = `${d.pair} · ${TIMEFRAME_LABEL[d.timeframe]} (${d.candles.length} velas)`;
    sel.appendChild(opt);
  }
  sel.value = selectId && datasets.some((d) => d.id === selectId) ? selectId : datasets[0].id;
  currentPairId = sel.value;
  updateExpiryHint();
}
$("pairSelect").addEventListener("change", (e) => { currentPairId = e.target.value; updateExpiryHint(); });

// ---------------- backtest ----------------

$("runBtn").addEventListener("click", runBacktest);

async function runBacktest() {
  if (!currentPairId) { toast("Cargá un par en la pestaña Datos primero.", true); return; }
  const btn = $("runBtn");
  btn.disabled = true;
  btn.textContent = "Corriendo…";

  try {
    const dataset = await dbGet("datasets", currentPairId);
    if (!dataset) throw new Error("No se encontro el dataset seleccionado.");

    const strategyCfg = readStrategyConfig();
    const moneyCfg = readMoneyConfig();
    const expiryCandles = Number($("expiry_candles").value);

    const result = Engine.runBacktest(dataset.candles, strategyCfg, moneyCfg, expiryCandles);
    const summary = Engine.summarize(result);

    lastResult = { pair: dataset.pair, timeframe: dataset.timeframe, strategyCfg, moneyCfg, expiryCandles, summary, equityCurve: result.equityCurve, trades: result.trades };
    renderResults(lastResult);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<span class="btn-icon">▶</span> Correr backtest`;
  }
}

function renderResults(r) {
  $("resultsEmpty").classList.add("hidden");
  $("resultsContent").classList.remove("hidden");

  const s = r.summary;
  const metrics = [
    ["Operaciones", s.trades, null],
    ["Winrate", s.trades ? `${s.winrate_pct}%` : "—", null],
    ["Profit factor", s.trades ? s.profit_factor : "—", null],
    ["PnL neto", s.trades ? fmt(s.net_pnl) : "—", s.trades ? (s.net_pnl >= 0 ? "positive" : "negative") : null],
    ["Capital final", s.trades ? fmt(s.final_capital) : "—", null],
    ["Drawdown max", s.trades ? `${fmt(s.max_drawdown)} (${s.max_drawdown_pct}%)` : "—", "negative"],
    ["Expectativa/op.", s.trades ? fmt(s.expectancy_per_trade) : "—", s.trades ? (s.expectancy_per_trade >= 0 ? "positive" : "negative") : null],
    ["Ganadas / Perdidas", s.trades ? `${s.wins} / ${s.losses}` : "—", null],
  ];
  $("metricsGrid").innerHTML = metrics.map(([label, value, cls]) => `
    <div class="metric-card"><div class="metric-label">${label}</div><div class="metric-value ${cls || ""}">${value}</div></div>`).join("");

  renderChart(r.equityCurve);

  $("tradesCount").textContent = r.trades.length;
  document.querySelector("#tradesTable tbody").innerHTML = r.trades.slice(-500).map((t, i) => `
    <tr>
      <td>${i + 1}</td><td>${t.entry_time}</td><td>${t.direction}</td>
      <td>${fmt(t.entry_price)}</td><td>${fmt(t.exit_price)}</td><td>${fmt(t.stake)}</td>
      <td class="${t.result === "WIN" ? "win" : "loss"}">${t.result}</td>
      <td class="${t.pnl >= 0 ? "win" : "loss"}">${fmt(t.pnl)}</td><td>${fmt(t.capital_after)}</td>
    </tr>`).join("");
}

function renderChart(equityCurve, canvasId = "equityChart") {
  const ctx = $(canvasId).getContext("2d");
  if (canvasId === "equityChart" && equityChart) equityChart.destroy();
  const chart = new Chart(ctx, {
    type: "line",
    data: {
      labels: equityCurve.map((_, i) => i),
      datasets: [{ data: equityCurve, borderColor: "#E0A458", borderWidth: 1.6, pointRadius: 0, tension: 0.15, fill: { target: "origin", above: "rgba(224,164,88,0.08)" } }],
    },
    options: {
      responsive: true,
      animation: { duration: 400 },
      plugins: { legend: { display: false } },
      scales: { x: { display: false }, y: { grid: { color: "rgba(255,255,255,0.05)" }, ticks: { color: "#8596a6", font: { family: "IBM Plex Mono", size: 10 } } } },
    },
  });
  if (canvasId === "equityChart") equityChart = chart;
  return chart;
}

// ---------------- estrategias (biblioteca) ----------------

function syncEnabled() {
  return !!getBackendCfg().url;
}

$("saveStrategyBtn").addEventListener("click", async () => {
  const name = $("strategyName").value.trim();
  if (!name) { toast("Ponele un nombre a la estrategia.", true); return; }
  const id = newId();
  const item = {
    id, name,
    strategy: readStrategyConfig(),
    money: readMoneyConfig(),
    expiry_candles: Number($("expiry_candles").value),
    created_at: new Date().toISOString(),
  };
  await dbPut("strategies", item);
  if (syncEnabled()) {
    try {
      await backendApi("/api/sync/strategies", { method: "POST", body: JSON.stringify(item) });
    } catch (err) {
      toast(`Se guardó localmente, pero no se pudo sincronizar: ${err.message}`, true);
    }
  }
  toast(`Estrategia "${name}" guardada.`);
  $("strategyName").value = "";
  await renderStrategiesList();
});

async function renderStrategiesList() {
  let strategies;
  if (syncEnabled()) {
    try {
      strategies = await backendApi("/api/sync/strategies");
      for (const s of strategies) await dbPut("strategies", s); // cache offline
    } catch (err) {
      strategies = await dbGetAll("strategies");
      toast(`No se pudo sincronizar (mostrando copia local): ${err.message}`, true);
    }
  } else {
    strategies = await dbGetAll("strategies");
  }

  const el = $("strategiesList");
  if (strategies.length === 0) {
    el.innerHTML = `<p class="muted small">Todavia no guardaste ninguna estrategia.</p>`;
    return;
  }
  strategies.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  el.innerHTML = strategies.map((s) => {
    const activeIndicators = ["bb", "rsi", "cci", "stoch", "ma"].filter((k) => s.strategy[`${k}_enabled`]);
    return `
    <div class="lib-card">
      <div class="lib-card-top"><span class="lib-card-name">${s.name}</span><span class="lib-card-date">${fmtDate(s.created_at)}</span></div>
      <div class="lib-card-meta">Indicadores: <b>${activeIndicators.join(", ").toUpperCase() || "ninguno"}</b><br>Vencimiento: <b>${s.expiry_candles} velas</b></div>
      <div class="lib-card-actions">
        <button data-action="load-strategy" data-id="${s.id}">Cargar en Backtest</button>
        <button class="danger" data-action="delete-strategy" data-id="${s.id}">Eliminar</button>
      </div>
    </div>`;
  }).join("");

  el.querySelectorAll("[data-action=load-strategy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const s = await dbGet("strategies", btn.dataset.id);
      writeStrategyConfig(s.strategy);
      writeMoneyConfig(s.money);
      $("expiry_candles").value = s.expiry_candles;
      $("strategyName").value = s.name;
      document.querySelector('.tab-btn[data-tab="backtest"]').click();
      toast(`Estrategia "${s.name}" cargada en la pestaña Backtest.`);
    });
  });
  el.querySelectorAll("[data-action=delete-strategy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("¿Eliminar esta estrategia?")) return;
      await dbDelete("strategies", btn.dataset.id);
      if (syncEnabled()) {
        try { await backendApi(`/api/sync/strategies/${btn.dataset.id}`, { method: "DELETE" }); }
        catch (err) { toast(`No se pudo borrar del servidor: ${err.message}`, true); }
      }
      await renderStrategiesList();
    });
  });
}

// ---------------- backtests (biblioteca) ----------------

$("saveBacktestBtn").addEventListener("click", async () => {
  if (!lastResult) return;
  const name = $("backtestName").value.trim();
  if (!name) { toast("Ponele un nombre a este backtest.", true); return; }
  const id = newId();
  const item = {
    id, name,
    pair: lastResult.pair, timeframe: lastResult.timeframe,
    strategy: lastResult.strategyCfg, money: lastResult.moneyCfg,
    expiry_candles: lastResult.expiryCandles,
    summary: lastResult.summary, equity_curve: lastResult.equityCurve,
    trades: lastResult.trades,
    created_at: new Date().toISOString(),
  };
  await dbPut("backtests", item);
  if (syncEnabled()) {
    try {
      await backendApi("/api/sync/backtests", { method: "POST", body: JSON.stringify(item) });
    } catch (err) {
      toast(`Se guardó localmente, pero no se pudo sincronizar: ${err.message}`, true);
    }
  }
  toast(`Backtest "${name}" guardado (ID ${id}).`);
  $("backtestName").value = "";
  await renderBacktestsList();
});

async function renderBacktestsList() {
  let backtests;
  if (syncEnabled()) {
    try {
      backtests = await backendApi("/api/sync/backtests");
      for (const b of backtests) await dbPut("backtests", b); // cache offline
    } catch (err) {
      backtests = await dbGetAll("backtests");
      toast(`No se pudo sincronizar (mostrando copia local): ${err.message}`, true);
    }
  } else {
    backtests = await dbGetAll("backtests");
  }

  const el = $("backtestsList");
  if (backtests.length === 0) {
    el.innerHTML = `<p class="muted small">Todavia no guardaste ningun backtest.</p>`;
    return;
  }
  backtests.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  el.innerHTML = backtests.map((b) => {
    const s = b.summary || {};
    const pnlCls = s.net_pnl === undefined ? "" : s.net_pnl >= 0 ? "positive" : "negative";
    return `
    <div class="lib-card">
      <div class="lib-card-top"><span class="lib-card-name">${b.name}</span><span class="lib-card-date">#${b.id}</span></div>
      <div class="lib-card-meta">${b.pair} · ${TIMEFRAME_LABEL[b.timeframe]} — ${fmtDate(b.created_at)}</div>
      <div class="lib-card-stats">
        <span>Winrate: <b>${s.winrate_pct !== undefined ? s.winrate_pct + "%" : "—"}</b></span>
        <span>PnL: <b class="${pnlCls}">${s.net_pnl !== undefined ? fmt(s.net_pnl) : "—"}</b></span>
      </div>
      <canvas id="mini-${b.id}" height="60" style="margin-bottom:10px;"></canvas>
      <div class="lib-card-actions">
        <button data-action="load-backtest" data-id="${b.id}">Reabrir en Backtest</button>
        <button class="danger" data-action="delete-backtest" data-id="${b.id}">Eliminar</button>
      </div>
    </div>`;
  }).join("");

  for (const b of backtests) {
    if (b.equity_curve && b.equity_curve.length > 1) {
      const ctx = document.getElementById(`mini-${b.id}`);
      if (ctx) {
        new Chart(ctx.getContext("2d"), {
          type: "line",
          data: { labels: b.equity_curve.map((_, i) => i), datasets: [{ data: b.equity_curve, borderColor: "#E0A458", borderWidth: 1.2, pointRadius: 0 }] },
          options: { responsive: true, animation: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { display: false } } },
        });
      }
    }
  }

  el.querySelectorAll("[data-action=load-backtest]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const b = await dbGet("backtests", btn.dataset.id);
      writeStrategyConfig(b.strategy);
      writeMoneyConfig(b.money);
      $("expiry_candles").value = b.expiry_candles;
      await refreshPairSelect(`${b.pair}::${b.timeframe}`);
      lastResult = { pair: b.pair, timeframe: b.timeframe, strategyCfg: b.strategy, moneyCfg: b.money, expiryCandles: b.expiry_candles, summary: b.summary, equityCurve: b.equity_curve, trades: b.trades };
      document.querySelector('.tab-btn[data-tab="backtest"]').click();
      renderResults(lastResult);
      toast(`Backtest "${b.name}" reabierto.`);
    });
  });
  el.querySelectorAll("[data-action=delete-backtest]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("¿Eliminar este backtest?")) return;
      await dbDelete("backtests", btn.dataset.id);
      if (syncEnabled()) {
        try { await backendApi(`/api/sync/backtests/${btn.dataset.id}`, { method: "DELETE" }); }
        catch (err) { toast(`No se pudo borrar del servidor: ${err.message}`, true); }
      }
      await renderBacktestsList();
    });
  });
}

// ---------------- Etapa 3: configuracion del servidor en la nube ----------------

function getBackendCfg() {
  return {
    url: (localStorage.getItem("smith_backend_url") || "").replace(/\/$/, ""),
    token: localStorage.getItem("smith_backend_token") || "",
  };
}

function loadBackendCfgIntoForm() {
  const cfg = getBackendCfg();
  $("backendUrlInput").value = cfg.url;
  $("backendTokenInput").value = cfg.token;
  $("backendStatus").textContent = cfg.url ? "configurado" : "sin configurar";
}

$("saveBackendCfgBtn").addEventListener("click", async () => {
  const url = $("backendUrlInput").value.trim().replace(/\/$/, "");
  const token = $("backendTokenInput").value.trim();
  localStorage.setItem("smith_backend_url", url);
  localStorage.setItem("smith_backend_token", token);
  $("backendStatus").textContent = url ? "configurado" : "sin configurar";
  toast("Configuración del servidor guardada.");
  await renderServerDatasetsList();
});

async function backendApi(path, opts = {}) {
  const cfg = getBackendCfg();
  if (!cfg.url) throw new Error('Configurá la URL del servidor arriba en "⚙ Configuración del servidor".');
  const res = await fetch(`${cfg.url}${path}`, {
    headers: { "Content-Type": "application/json", "X-API-Key": cfg.token },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

// ---------------- Etapa 3: pedir datos a IQ Option ----------------

$("iqFetchBtn").addEventListener("click", async () => {
  const email = $("iqEmailInput").value.trim();
  const password = $("iqPasswordInput").value;
  const pairs = $("iqPairsInput").value.split(",").map((p) => p.trim().toUpperCase()).filter(Boolean);
  const timeframe = $("iqTimeframeInput").value;
  const candles = Number($("iqCandlesInput").value);
  const endLocal = $("iqEndInput").value;

  if (!email || !password) { toast("Completá usuario y contraseña de IQ Option.", true); return; }
  if (pairs.length === 0) { toast("Escribí al menos un par.", true); return; }

  const btn = $("iqFetchBtn");
  btn.disabled = true;
  btn.textContent = "Iniciando…";

  try {
    const body = { email, password, pairs, timeframe, candles, practice: true };
    if (endLocal) body.end = new Date(endLocal).toISOString();

    const { job_id } = await backendApi("/api/fetch-iqoption/start", { method: "POST", body: JSON.stringify(body) });
    $("iqPasswordInput").value = ""; // no la dejamos flotando en el campo mas de lo necesario
    btn.textContent = "Descargando…";
    await pollFetchJob(job_id, timeframe);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Pedir a IQ Option";
  }
});

function renderFetchProgress(job) {
  const el = $("fetchProgress");
  el.classList.remove("hidden");
  el.innerHTML = Object.entries(job.pairs).map(([pair, p]) => {
    const pct = p.total ? Math.min(100, Math.round((100 * p.downloaded) / p.total)) : 0;
    const cls = p.status === "done" ? "done" : p.status === "error" ? "error" : "";
    return `
    <div class="progress-item ${cls}">
      <div class="progress-item-top"><b>${pair}</b><span>${p.downloaded}/${p.total} velas — ${p.status}</span></div>
      <div class="progress-bar-track"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
      ${p.error ? `<div class="progress-item-error">${p.error}</div>` : ""}
    </div>`;
  }).join("");
}

async function pollFetchJob(jobId, timeframe) {
  while (true) {
    const job = await backendApi(`/api/fetch-iqoption/status/${jobId}`);
    renderFetchProgress(job);
    if (job.status === "error") { toast(job.error, true); return; }
    if (job.status === "done") break;
    await new Promise((r) => setTimeout(r, 1200));
  }

  // traer al navegador cada par que termino OK y guardarlo en IndexedDB
  const job = await backendApi(`/api/fetch-iqoption/status/${jobId}`);
  let lastPair = null;
  for (const [pair, p] of Object.entries(job.pairs)) {
    if (p.status !== "done") continue;
    try {
      const data = await backendApi(`/api/pairs/${encodeURIComponent(pair)}/data?timeframe=${timeframe}`);
      const id = `${pair}::${timeframe}`;
      await dbPut("datasets", { id, pair, timeframe, candles: data.candles, created_at: new Date().toISOString() });
      lastPair = id;
    } catch (err) {
      toast(`No se pudo traer ${pair} al navegador: ${err.message}`, true);
    }
  }
  toast("Descarga completa — datos disponibles en la pestaña Backtest.");
  await renderDatasetsList();
  if (lastPair) await refreshPairSelect(lastPair);
}

// ---------------- Etapa 4: operativa en vivo ----------------

let liveSessionId = localStorage.getItem("smith_live_session_id") || null;
let livePollTimer = null;

$("liveModeSelect").addEventListener("change", updateLiveModeUI);
function updateLiveModeUI() {
  const mode = $("liveModeSelect").value;
  $("liveCredsBox").classList.toggle("hidden", mode === "simulate");
  $("liveRealBox").classList.toggle("hidden", mode !== "real");
}
updateLiveModeUI();

async function populateLiveStrategySelect() {
  const strategies = await dbGetAll("strategies");
  const sel = $("liveStrategySelect");
  sel.innerHTML = strategies.length
    ? strategies.map((s) => `<option value="${s.id}">${s.name}</option>`).join("")
    : `<option value="">Sin estrategias guardadas</option>`;
}

document.querySelector('.tab-btn[data-tab="live"]').addEventListener("click", async () => {
  await populateLiveStrategySelect();
  await renderLiveSessionsList();  // sesiones de OTROS dispositivos, no solo la propia
  if (liveSessionId) resumePolling();
});

$("liveStartBtn").addEventListener("click", async () => {
  const strategyId = $("liveStrategySelect").value;
  if (!strategyId) { toast("Guardá o elegí una estrategia primero.", true); return; }
  const strategy = await dbGet("strategies", strategyId);

  const pair = $("livePairInput").value.trim().toUpperCase();
  const timeframe = $("liveTimeframeInput").value;
  const mode = $("liveModeSelect").value;
  const dryRun = $("liveDryRunInput").checked;
  if (!pair) { toast("Escribí un par.", true); return; }

  const body = {
    mode, pair, timeframe,
    strategy: strategy.strategy, money: strategy.money,
    expiry_candles: strategy.expiry_candles,
    dry_run: mode === "simulate" ? false : dryRun,
    name: strategy.name,
  };

  if (mode !== "simulate") {
    body.email = $("liveEmailInput").value.trim();
    body.password = $("livePasswordInput").value;
    if (!body.email || !body.password) { toast("Completá usuario y contraseña de IQ Option.", true); return; }
  }
  if (mode === "real") {
    body.confirm_real = $("liveConfirmRealInput").value.trim();
    if (body.confirm_real !== "ACEPTO-EL-RIESGO") {
      toast('Para cuenta real, escribí exactamente "ACEPTO-EL-RIESGO" en el campo de confirmación.', true);
      return;
    }
  }

  const btn = $("liveStartBtn");
  btn.disabled = true;
  btn.textContent = "Iniciando…";
  try {
    const { session_id } = await backendApi("/api/live/start", { method: "POST", body: JSON.stringify(body) });
    $("livePasswordInput").value = "";
    liveSessionId = session_id;
    localStorage.setItem("smith_live_session_id", session_id);
    toast(`Sesión iniciada (${session_id}).`);
    resumePolling();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "▶ Iniciar sesión";
  }
});

$("liveStopBtn").addEventListener("click", async () => {
  if (!liveSessionId) return;
  try {
    await backendApi(`/api/live/stop/${liveSessionId}`, { method: "POST" });
    toast("Deteniendo sesión…");
  } catch (err) {
    toast(err.message, true);
  }
});

function resumePolling() {
  $("liveStatusPanel").classList.remove("hidden");
  $("liveStopBtn").classList.remove("hidden");
  clearInterval(livePollTimer);
  pollLiveStatus();
  livePollTimer = setInterval(pollLiveStatus, 1500);
}

async function pollLiveStatus() {
  if (!liveSessionId) return;
  try {
    const s = await backendApi(`/api/live/status/${liveSessionId}`);
    renderLiveStatus(s);
    if (s.status === "stopped" || s.status === "error") {
      clearInterval(livePollTimer);
    }
  } catch (err) {
    clearInterval(livePollTimer);
  }
  await renderLiveSessionsList();
}

function renderLiveStatus(s) {
  const sum = s.summary || {};
  $("liveMetricsGrid").innerHTML = `
    <div class="metric-card"><div class="metric-label">Estado</div><div class="metric-value"><span class="session-status ${s.status}">${s.status}</span></div></div>
    <div class="metric-card"><div class="metric-label">Capital</div><div class="metric-value">${s.capital !== null ? fmt(s.capital) : "—"}</div></div>
    <div class="metric-card"><div class="metric-label">Operaciones</div><div class="metric-value">${s.trades_count}</div></div>
    <div class="metric-card"><div class="metric-label">Modo</div><div class="metric-value" style="font-size:13px;">${s.mode}${s.dry_run ? " (dry-run)" : ""}</div></div>
    <div class="metric-card"><div class="metric-label">Winrate</div><div class="metric-value">${sum.trades ? sum.winrate_pct + "%" : "—"}</div></div>
    <div class="metric-card"><div class="metric-label">PnL neto</div><div class="metric-value ${sum.trades ? (sum.net_pnl >= 0 ? "positive" : "negative") : ""}">${sum.trades ? fmt(sum.net_pnl) : "—"}</div></div>
    <div class="metric-card"><div class="metric-label">Profit factor</div><div class="metric-value">${sum.trades && sum.profit_factor !== null ? sum.profit_factor : "—"}</div></div>
    <div class="metric-card"><div class="metric-label">Expectativa/op.</div><div class="metric-value ${sum.trades ? (sum.expectancy_per_trade >= 0 ? "positive" : "negative") : ""}">${sum.trades ? fmt(sum.expectancy_per_trade) : "—"}</div></div>
  `;

  const banner = $("currentOrderBanner");
  if (s.current_order) {
    banner.classList.remove("hidden");
    banner.textContent = `Ejecutando ${s.current_order.direction} ${s.pair} — stake ${fmt(s.current_order.stake)} (desde ${s.current_order.entry_time})`;
  } else {
    banner.classList.add("hidden");
  }

  $("liveTradesCount").textContent = s.trades.length;
  document.querySelector("#liveTradesTable tbody").innerHTML = s.trades.slice().reverse().map((t, i) => `
    <tr>
      <td>${s.trades.length - i}</td><td>${t.entry_time}</td><td>${t.direction}</td><td>${fmt(t.stake)}</td>
      <td class="${t.status === "open" ? "" : t.result === "WIN" ? "win" : "loss"}">${t.status === "open" ? "en curso…" : t.result || t.status}</td>
      <td class="${t.pnl >= 0 ? "win" : t.pnl < 0 ? "loss" : ""}">${t.pnl !== null ? fmt(t.pnl) : "—"}</td>
      <td>${t.capital_after !== null ? fmt(t.capital_after) : "—"}</td>
    </tr>`).join("");

  $("liveLog").innerHTML = s.log.map((l) => `<div class="live-log-line"><span class="t">${l.at}</span>${l.msg}</div>`).join("");
  $("liveLog").scrollTop = $("liveLog").scrollHeight;
  if (s.error) toast(s.error, true);
}

async function renderLiveSessionsList() {
  let sessions;
  try {
    sessions = await backendApi("/api/live/sessions");
  } catch {
    return;
  }
  const el = $("liveSessionsList");
  if (!sessions.length) {
    el.innerHTML = `<p class="muted small">Sin sesiones todavía.</p>`;
    return;
  }
  el.innerHTML = sessions.map((s) => {
    const sum = s.summary || {};
    const winrateTxt = sum.trades ? `${sum.winrate_pct}%` : "—";
    const pnlTxt = sum.trades ? fmt(sum.net_pnl) : "—";
    const pnlCls = sum.trades ? (sum.net_pnl >= 0 ? "positive" : "negative") : "";
    return `
    <div class="lib-card">
      <div class="lib-card-top"><span class="lib-card-name">${s.pair} · ${s.timeframe}</span><span class="session-status ${s.status}">${s.status}</span></div>
      <div class="lib-card-meta">Modo: <b>${s.mode}</b>${s.dry_run ? " (dry-run)" : ""} — desde ${fmtDate(s.started_at)}<br>Capital: <b>${s.capital !== null ? fmt(s.capital) : "—"}</b> — Operaciones: <b>${s.trades_count}</b></div>
      <div class="lib-card-stats"><span>Winrate: <b>${winrateTxt}</b></span><span>PnL: <b class="${pnlCls}">${pnlTxt}</b></span></div>
      <div class="lib-card-actions"><button data-action="reconnect-session" data-id="${s.id}">Reconectar</button></div>
    </div>`;
  }).join("");
  el.querySelectorAll("[data-action=reconnect-session]").forEach((btn) => {
    btn.addEventListener("click", () => {
      liveSessionId = btn.dataset.id;
      localStorage.setItem("smith_live_session_id", liveSessionId);
      resumePolling();
    });
  });
}

// ---------------- auto-refresh: la pestaña activa se actualiza sola cada
// pocos segundos, para que los cambios hechos desde otro dispositivo
// (nuevas descargas, sesiones, estrategias) aparezcan sin tener que hacer
// nada manualmente. ----------------

const AUTO_REFRESH_MS = 6000;

async function refreshActiveTab() {
  const active = document.querySelector(".tab-btn.active")?.dataset.tab;
  if (!active) return;
  try {
    if (active === "strategies") await renderStrategiesList();
    else if (active === "backtests") await renderBacktestsList();
    else if (active === "data") { await renderDatasetsList(); await renderServerDatasetsList(); }
    else if (active === "live") await renderLiveSessionsList();
  } catch {
    // fallas de red silenciosas ac\u00e1 -- ya se avisan en el lugar que corresponda
  }
}

// ---------------- init ----------------

(async function init() {
  syncModuleToggles();
  loadBackendCfgIntoForm();
  await refreshPairSelect();
  setInterval(refreshActiveTab, AUTO_REFRESH_MS);
})();
