const AUTO_REFRESH_MS = 15_000;
const STALE_THRESHOLD_MS = 60_000;

let prevValues = {};
let refreshTimer = null;

function fmt(val, digits = 1) {
  const n = Number(val);
  if (!Number.isFinite(n)) return "—";
  return (n * 100).toFixed(digits) + "¢";
}

function fmtVol(val) {
  const n = Number(val);
  if (!Number.isFinite(n) || n === 0) return "—";
  if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return "$" + (n / 1_000).toFixed(1) + "K";
  return "$" + n.toFixed(0);
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function normLabel(s) {
  return String(s || "").toLowerCase()
    .replace(/[–—−]/g, "-")
    .replace(/[$€\s]/g, "");
}

function findPosition(label) {
  const positions = window._lastData?.positions || [];
  const key = normLabel(label);
  return positions.find(p => normLabel(p.tier) === key) || null;
}

function findOrders(marketId) {
  return (window._lastData?.openOrders || []).filter(o => o.marketId === marketId);
}

function fmtUsd(v) {
  if (!Number.isFinite(v)) return "—";
  return (v >= 0 ? "$" : "-$") + Math.abs(v).toFixed(2);
}

function renderOrdersBadge(orders) {
  if (!orders.length) return "—";
  const buys  = orders.filter(o => o.side === "BUY");
  const sells = orders.filter(o => o.side === "SELL");
  const parts = [];
  if (buys.length) {
    const avgP = buys.reduce((s, o) => s + o.price, 0) / buys.length;
    parts.push(`<span class="order-buy">↑${buys.length} @${(avgP*100).toFixed(0)}¢</span>`);
  }
  if (sells.length) {
    const avgP = sells.reduce((s, o) => s + o.price, 0) / sells.length;
    parts.push(`<span class="order-sell">↓${sells.length} @${(avgP*100).toFixed(0)}¢</span>`);
  }
  return parts.join(" ");
}

function makeSpark(bids, w = 72, h = 22) {
  if (!bids || bids.length === 0) return `<svg width="${w}" height="${h}" class="spark-svg"></svg>`;
  if (bids.length === 1) {
    return `<svg width="${w}" height="${h}" class="spark-svg"><circle cx="${w/2}" cy="${h/2}" r="2" fill="var(--muted)"/></svg>`;
  }
  const min = Math.min(...bids);
  const max = Math.max(...bids);
  const span = max - min || 0.001;
  const pad = 2;
  const pts = bids.map((b, i) => {
    const x = (pad + (i / (bids.length - 1)) * (w - pad * 2)).toFixed(1);
    const y = (pad + (1 - (b - min) / span) * (h - pad * 2)).toFixed(1);
    return `${x},${y}`;
  }).join(" ");
  const trend = bids[bids.length - 1] >= bids[0] ? "var(--bid)" : "var(--ask)";
  return `<svg width="${w}" height="${h}" class="spark-svg"><polyline points="${pts}" fill="none" stroke="${trend}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

function makeDistBar(bid) {
  if (!Number.isFinite(bid) || bid <= 0) return '<div class="dist-wrap"></div>';
  const pct = Math.min(100, bid * 100).toFixed(1);
  return `<div class="dist-wrap"><div class="dist-bar" style="width:${pct}%"></div></div>`;
}

function calc24hChange(key) {
  // Primary: value fetched from CLOB prices-history API (via backend)
  for (const ev of (window._lastData?.events || [])) {
    const m = ev.markets.find(m => m.id === key);
    if (m?.priceChange24h != null) return m.priceChange24h;
  }
  // Fallback: derive from locally accumulated price history
  const pts = (window._lastData?.priceHistory || {})[key] || [];
  if (pts.length < 2) return null;
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const old = pts.find(p => p.t <= cutoff);
  if (!old || !old.b) return null;
  return (pts[pts.length - 1].b - old.b) / old.b;
}

function fmtChg24h(pct) {
  if (pct === null || !Number.isFinite(pct)) return '<span class="muted">—</span>';
  const cls = pct >= 0 ? "bid" : "ask";
  return `<span class="${cls}">${pct >= 0 ? "+" : ""}${(pct * 100).toFixed(1)}%</span>`;
}

function escHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function marketUrl(market, eventSlug) {
  return `https://polymarket.com/event/${escHtml(eventSlug)}`;
}

// ── Section collapse ───────────────────────────────────────────────────────

const COLLAPSE_KEY = "kaiser-collapsed-v1";

function collapseGetState() {
  try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "{}"); } catch { return {}; }
}

function collapseSetState(slug, collapsed) {
  const s = collapseGetState();
  if (collapsed) s[slug] = true; else delete s[slug];
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(s)); } catch {}
}

function applyCollapse(section, collapsed) {
  const tw  = section.querySelector(".table-wrap");
  const btn = section.querySelector(".collapse-btn");
  section.dataset.collapsed = String(collapsed);
  if (tw)  tw.hidden       = collapsed;
  if (btn) btn.textContent = collapsed ? "▸" : "▾";
}

function toggleSection(section) {
  const collapsed = section.dataset.collapsed !== "true";
  applyCollapse(section, collapsed);
  collapseSetState(section.dataset.slug, collapsed);
}

function flashCell(el, newVal, key) {
  const prev = prevValues[key];
  if (prev !== undefined && prev !== newVal) {
    el.classList.remove("flash-up", "flash-down");
    void el.offsetWidth;
    el.classList.add(newVal > prev ? "flash-up" : "flash-down");
  }
  prevValues[key] = newVal;
}

function buildEventSection(ev) {
  const section = document.createElement("section");
  section.className = "event-section";
  section.dataset.slug = ev.slug;

  const statusDot = ev.active && !ev.closed ? '<span class="dot live"></span>' : '<span class="dot closed"></span>';
  const volLabel = ev.volume24hr ? fmtVol(ev.volume24hr) + " vol 24h" : "";

  section.innerHTML = `
    <div class="event-header event-header-clickable">
      <div class="event-title-row">
        <button class="collapse-btn" title="Collapse / expand">▾</button>
        ${statusDot}
        <h2 class="event-title">
          <a href="https://polymarket.com/event/${escHtml(ev.slug)}" target="_blank" rel="noreferrer">${escHtml(ev.title)}</a>
        </h2>
        <span class="event-meta">${escHtml(volLabel)}</span>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th class="col-label">Range / Market</th>
            <th class="col-spark">History</th>
            <th class="col-chg24h num">24h</th>
            <th class="col-bid">Bid</th>
            <th class="col-dist">Dist</th>
            <th class="col-ask">Ask</th>
            <th class="col-spread">Spread</th>
            <th class="col-mid">Mid</th>
            <th class="col-last">Last</th>
            <th class="col-vol">Vol 24h</th>
          </tr>
        </thead>
        <tbody class="market-rows"></tbody>
      </table>
    </div>
  `;

  const tbody = section.querySelector(".market-rows");
  const history = window._lastData?.priceHistory || {};

  for (const m of ev.markets) {
    if (m.closed && !m.active) continue;
    const tr = document.createElement("tr");
    const key = m.id;

    const bid = m.bestBid;
    const ask = m.bestAsk;
    const spread = (typeof bid === "number" && typeof ask === "number") ? (ask - bid) : null;
    const mid = (typeof bid === "number" && typeof ask === "number") ? (bid + ask) / 2 : null;

    const label = m.label || m.question;
    const shortLabel = label.length > 80 ? label.slice(0, 78) + "…" : label;

    tr.dataset.marketId = key;
    tr.innerHTML = `
      <td class="col-label">
        <a href="${marketUrl(m, ev.slug)}" target="_blank" rel="noreferrer" title="${escHtml(m.question)}">${escHtml(shortLabel)}</a>
      </td>
      <td class="col-spark" data-key="${key}-spark">${makeSpark(history[key])}</td>
      <td class="col-chg24h num" data-key="${key}-chg24h">${fmtChg24h(calc24hChange(key))}</td>
      <td class="col-bid num bid" data-key="${key}-bid">${fmt(bid)}</td>
      <td class="col-dist" data-key="${key}-dist">${makeDistBar(bid)}</td>
      <td class="col-ask num ask" data-key="${key}-ask">${fmt(ask)}</td>
      <td class="col-spread num muted" data-key="${key}-spread">${fmt(spread)}</td>
      <td class="col-mid num muted" data-key="${key}-mid">${fmt(mid)}</td>
      <td class="col-last num muted" data-key="${key}-last">${fmt(m.lastTradePrice)}</td>
      <td class="col-vol num muted">${fmtVol(m.volume24hr)}</td>
    `;

    flashCell(tr.querySelector('[data-key="' + key + '-bid"]'), bid, key + "-bid");
    flashCell(tr.querySelector('[data-key="' + key + '-ask"]'), ask, key + "-ask");

    tbody.appendChild(tr);
  }

  if (tbody.children.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="10" class="empty">No active markets</td>';
    tbody.appendChild(tr);
  }

  // Restore saved collapse state
  if (collapseGetState()[ev.slug]) applyCollapse(section, true);

  section.querySelector(".event-header-clickable").addEventListener("click", e => {
    if (e.target.closest("a")) return;  // let title link navigate normally
    toggleSection(section);
  });



  return section;
}

function updateExistingSection(section, ev) {
  const tbody = section.querySelector(".market-rows");
  const rows = Array.from(tbody.querySelectorAll("tr[data-market-id]"));

  for (const m of ev.markets) {
    if (m.closed && !m.active) continue;
    const key = m.id;
    const existingRow = tbody.querySelector(`tr[data-market-id="${key}"]`);

    const bid = m.bestBid;
    const ask = m.bestAsk;
    const spread = (typeof bid === "number" && typeof ask === "number") ? (ask - bid) : null;
    const mid = (typeof bid === "number" && typeof ask === "number") ? (bid + ask) / 2 : null;

    if (existingRow) {
      const bidEl    = existingRow.querySelector('[data-key="' + key + '-bid"]');
      const askEl    = existingRow.querySelector('[data-key="' + key + '-ask"]');
      const spreadEl = existingRow.querySelector('[data-key="' + key + '-spread"]');
      const midEl    = existingRow.querySelector('[data-key="' + key + '-mid"]');
      const lastEl   = existingRow.querySelector('[data-key="' + key + '-last"]');
      const sparkEl  = existingRow.querySelector('[data-key="' + key + '-spark"]');
      const distEl   = existingRow.querySelector('[data-key="' + key + '-dist"]');

      if (bidEl) { flashCell(bidEl, bid, key + "-bid"); bidEl.textContent = fmt(bid); }
      if (askEl) { flashCell(askEl, ask, key + "-ask"); askEl.textContent = fmt(ask); }
      if (spreadEl) spreadEl.textContent = fmt(spread);
      if (midEl) midEl.textContent = fmt(mid);
      if (lastEl) lastEl.textContent = fmt(m.lastTradePrice);
      const history = window._lastData?.priceHistory || {};
      if (sparkEl) sparkEl.innerHTML = makeSpark(history[key]);
      if (distEl)  distEl.innerHTML  = makeDistBar(bid);
      const chg24hEl = existingRow.querySelector('[data-key="' + key + '-chg24h"]');
      if (chg24hEl)  chg24hEl.innerHTML = fmtChg24h(calc24hChange(key));
    }
  }
  // Remove stale row tracking — rows with data-market-id not in new data
  for (const row of rows) {
    const id = row.dataset.marketId;
    if (!ev.markets.find((m) => m.id === id)) row.remove();
  }
}

// ── Wallet address ─────────────────────────────────────────────────────────

const WALLET_KEY = "kaiser-wallet-v1";

function walletLoad() {
  return localStorage.getItem(WALLET_KEY) || "";
}

function walletSave(addr) {
  if (addr) localStorage.setItem(WALLET_KEY, addr);
  else localStorage.removeItem(WALLET_KEY);
}

const ADMIN_TOKEN_KEY = "kaiser-admin-token-v1";

function adminToken() {
  return localStorage.getItem(ADMIN_TOKEN_KEY) || "";
}

async function adminPost(path, body) {
  const doFetch = () => fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${adminToken()}` },
    body: JSON.stringify(body),
  });
  let res = await doFetch();
  if (res.status === 401) {
    const token = prompt("Admin token required to change settings:");
    if (!token) return false;
    localStorage.setItem(ADMIN_TOKEN_KEY, token.trim());
    res = await doFetch();
  }
  return res.ok;
}

// ── Slug manager ───────────────────────────────────────────────────────────

function slugFromInput(raw) {
  const s = raw.trim();
  try {
    const url = new URL(s);
    const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    return parts[parts.length - 1] || "";
  } catch {
    return s.toLowerCase().replace(/\s+/g, "-");
  }
}

let slugManagerBuilt = false;

function buildSlugManager(slugs) {
  if (!slugManagerBuilt) {
    slugManagerBuilt = true;

    const panel = document.createElement("div");
    panel.id = "events-panel";
    panel.className = "events-panel";
    panel.innerHTML = `
      <div class="events-panel-inner">
        <div class="slug-add-row">
          <input id="slug-input" class="slug-input" type="text"
            placeholder="https://polymarket.com/event/market-slug" spellcheck="false">
          <button id="slug-add-btn" class="btn-preset">+ Add</button>
        </div>
        <div id="slug-chips" class="slug-chips"></div>
        <div class="slug-add-row wallet-row">
          <label class="slug-label">Wallet</label>
          <input id="wallet-input" class="slug-input wallet-input" type="text"
            placeholder="0x… public wallet address (optional)" spellcheck="false"
            value="${escHtml(walletLoad())}">
          <button id="wallet-save-btn" class="btn-preset">Set</button>
          <button id="wallet-clear-btn" class="btn-preset">Clear</button>
        </div>
      </div>`;
    document.querySelector("header").after(panel);

    document.getElementById("slug-add-btn").addEventListener("click", () => {
      const input = document.getElementById("slug-input");
      const slug = slugFromInput(input.value);
      if (!slug) return;
      const cur = Array.from(document.querySelectorAll(".slug-chip[data-slug]")).map(el => el.dataset.slug);
      if (!cur.includes(slug)) postSlugs([...cur, slug]);
      input.value = "";
    });

    document.getElementById("slug-input").addEventListener("keydown", e => {
      if (e.key === "Enter") document.getElementById("slug-add-btn").click();
    });

    document.getElementById("wallet-save-btn").addEventListener("click", () => {
      const addr = document.getElementById("wallet-input").value.trim();
      walletSave(addr);
      refresh();
    });

    document.getElementById("wallet-input").addEventListener("keydown", e => {
      if (e.key === "Enter") document.getElementById("wallet-save-btn").click();
    });

    document.getElementById("wallet-clear-btn").addEventListener("click", () => {
      document.getElementById("wallet-input").value = "";
      walletSave("");
      refresh();
    });
  }

  const chips = document.getElementById("slug-chips");
  if (!chips) return;
  const existing = Array.from(chips.querySelectorAll(".slug-chip[data-slug]")).map(el => el.dataset.slug);
  if (JSON.stringify(existing) === JSON.stringify(slugs)) return;

  chips.innerHTML = slugs.map(s => `
    <span class="slug-chip" data-slug="${escHtml(s)}">${escHtml(s)}
      <button class="slug-chip-del" data-slug="${escHtml(s)}" title="Remove">✕</button>
    </span>`).join("");

  chips.querySelectorAll(".slug-chip-del").forEach(b => {
    b.addEventListener("click", () => {
      const cur = Array.from(document.querySelectorAll(".slug-chip[data-slug]")).map(el => el.dataset.slug);
      if (cur.length <= 1) { alert("At least one event is required."); return; }
      postSlugs(cur.filter(s => s !== b.dataset.slug));
    });
  });
}

async function postSlugs(slugs) {
  const ok = await adminPost("/slugs", { slugs });
  if (ok) location.reload();
}

// ── Resolved events ────────────────────────────────────────────────────────

function buildResolvedSection(rv) {
  const section = document.createElement("section");
  section.className = "event-section resolved-section";
  section.dataset.resolvedSlug = rv.slug;

  const resolvedAt = rv.resolvedAt
    ? new Date(rv.resolvedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
    : "—";

  const hasPositions = rv.positions?.length > 0;
  const posHeaders = hasPositions
    ? '<th class="num">Entry</th><th class="num">Invested</th><th class="num">Final P&amp;L</th>'
    : "";

  const rows = rv.markets.map(m => {
    const winIdx = (m.outcomePrices || []).findIndex(p => p >= 0.99);
    const winner = winIdx >= 0 ? (m.outcomes || [])[winIdx] : null;
    const pos = (rv.positions || []).find(p => p.tier === m.label);
    let posCell = "";
    if (hasPositions) {
      if (pos) {
        const won = winner !== null && m.label === (rv.markets.find(x =>
          (x.outcomePrices || []).findIndex(p => p >= 0.99) >= 0 && x.label === m.label
        )?.label);
        const finalPnl = pos.cashPnl ?? (pos.size * (winIdx >= 0 ? 1 : 0) - pos.invested);
        const cls = finalPnl >= 0 ? "bid" : "ask";
        posCell = `<td class="num muted">${fmt(pos.entry)}</td>
          <td class="num muted">${fmtUsd(pos.invested)}</td>
          <td class="num ${cls}">${fmtUsd(finalPnl)}</td>`;
      } else {
        posCell = "<td></td><td></td><td></td>";
      }
    }
    const outcomeCell = winner
      ? `<span class="bid">✓ ${escHtml(winner)}</span>`
      : '<span class="muted">—</span>';
    return `<tr class="${winner ? "resolved-winner" : ""}">
      <td class="col-label">${escHtml(m.label)}</td>
      <td class="num">${outcomeCell}</td>
      ${posCell}
    </tr>`;
  }).join("");

  section.innerHTML = `
    <div class="event-header">
      <div class="event-title-row">
        <span class="dot closed"></span>
        <h2 class="event-title">${escHtml(rv.title)}</h2>
        <span class="badge-resolved">Resolved</span>
        <span class="event-meta">${escHtml(resolvedAt)}</span>
      </div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr>
        <th class="col-label">Tier</th>
        <th class="num">Outcome</th>
        ${posHeaders}
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  return section;
}

function renderResolved(resolved) {
  if (!resolved?.length) return;
  const main = document.getElementById("main");
  for (const rv of resolved) {
    if (!main.querySelector(`section[data-resolved-slug="${rv.slug}"]`)) {
      main.appendChild(buildResolvedSection(rv));
    }
  }
}

// ── Main render ────────────────────────────────────────────────────────────

function render(data) {
  window._lastData = data;

  const main = document.getElementById("main");
  const loading = document.getElementById("loading");
  if (loading) loading.remove();

  for (const ev of data.events) {
    const existing = main.querySelector(`section[data-slug="${ev.slug}"]`);
    if (existing) {
      updateExistingSection(existing, ev);
    } else {
      const section = buildEventSection(ev);
      main.appendChild(section);
    }
  }

  const lastUpdateEl = document.getElementById("lastUpdate");
  if (lastUpdateEl) lastUpdateEl.textContent = "Updated " + fmtTime(data.fetchedAt);

  const staleEl = document.getElementById("staleWarning");
  if (staleEl) {
    const age = data.fetchedAt ? Date.now() - new Date(data.fetchedAt).getTime() : Infinity;
    staleEl.hidden = age < STALE_THRESHOLD_MS;
  }

  buildSlugManager(data.slugs || []);
  renderResolved(data.resolved);
  buildCalc(data.events);
}

async function fetchData() {
  const res = await fetch("/data", { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchUserPositions() {
  const wallet = walletLoad();
  if (!wallet) return [];
  try {
    const res = await fetch(`/positions?address=${encodeURIComponent(wallet)}`, { cache: "no-store" });
    if (!res.ok) return [];
    return res.json();
  } catch { return []; }
}

async function refresh() {
  try {
    const [data, positions] = await Promise.all([fetchData(), fetchUserPositions()]);
    data.positions = positions;
    render(data);
  } catch (err) {
    console.error("[app] refresh failed:", err.message);
    const lastUpdateEl = document.getElementById("lastUpdate");
    if (lastUpdateEl) lastUpdateEl.textContent = "Fetch error: " + err.message;
  }
}

document.getElementById("refreshBtn").addEventListener("click", () => {
  clearInterval(refreshTimer);
  refresh();
  refreshTimer = setInterval(refresh, AUTO_REFRESH_MS);
});

refresh();
refreshTimer = setInterval(refresh, AUTO_REFRESH_MS);

// ── Tier Matrix Calculator ─────────────────────────────────────────────────

const CALC_STORAGE_KEY = "kaiser-calc-v1";

function calcSaveState() {
  const rowState = {};
  calc.rows.forEach(r => { rowState[r.id] = { included: r.included, factor: r.factor }; });
  try {
    localStorage.setItem(CALC_STORAGE_KEY, JSON.stringify({
      slug:             calc.slug,
      priceType:        calc.priceType,
      total:            calc.total,
      anchorId:         calc.anchorId,
      breakEvenId:      calc.breakEvenId,
      breakEvenEnabled: calc.breakEvenEnabled,
      rows:             rowState,
    }));
  } catch (_) {}
}

function calcRestoreState() {
  try {
    const raw = localStorage.getItem(CALC_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

const calc = {
  slug: null,
  priceType: "bid",          // default bid: sum(bids) < 1 shows real arb
  total: 1000,
  rows: [],      // {id, label, price, mid, included, factor}
  anchorId: null,            // null = free mode; set = anchor row (Dmax formula)
  breakEvenId: null,         // which row is locked at factor=0
  breakEvenEnabled: true,    // false = no break-even row
  built: false,
  snapshotMode: false,       // true = prices are frozen from a saved snapshot
};

function calcGetPrice(m) {
  if (calc.priceType === "bid") return m.bestBid;
  if (calc.priceType === "ask") return m.bestAsk;
  const b = m.bestBid, a = m.bestAsk;
  return b != null && a != null ? (b + a) / 2 : (b ?? a ?? null);
}

function calcMid(m) {
  const b = m.bestBid ?? 0, a = m.bestAsk ?? 0;
  return (b + a) / 2;
}

function fmtEur(v) {
  return Number.isFinite(v) ? "€" + v.toFixed(2) : "—";
}

function fmtPct(v) {
  if (!Number.isFinite(v)) return "—";
  return (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%";
}

function effectiveFactor(r) {
  if (calc.anchorId !== null && r.id === calc.anchorId) return 1;
  if (calc.breakEvenEnabled && r.id === calc.breakEvenId) return 0;
  return r.factor;
}

function updateInputLabel() {
  const el = document.getElementById("c-total-label-text");
  if (el) el.textContent = calc.anchorId !== null ? "Anchor Investment" : "Total Investment";
}

function runCalc() {
  const active = calc.rows.filter(r => r.included && r.price > 0);
  if (active.length < 2) return { err: "Select at least 2 tiers." };

  const priceSum = active.reduce((s, r) => s + r.price, 0);
  let results, Dtotal, Dmax;

  const anchorRow = calc.anchorId !== null ? active.find(r => r.id === calc.anchorId) : null;

  if (anchorRow) {
    // ── Anchor mode: user sets Dmax; formula derives Dtotal ──────────────
    const Bmax   = anchorRow.price;
    const others = active.filter(r => r.id !== anchorRow.id);

    const sumBC  = others.reduce((s, r) => s + r.price * effectiveFactor(r), 0);
    const sumB1C = others.reduce((s, r) => s + r.price * (1 - effectiveFactor(r)), 0);
    const den    = 1 - sumB1C;
    if (den <= 0) return { err: "No solution: weighted price sum ≥ 1. Lower profit factors." };

    Dmax   = calc.total;
    Dtotal = Dmax * (1 + sumBC / Bmax) / den;

    results = active.map(r => {
      const f  = effectiveFactor(r);
      const Di = r.price * ((1 - f) * Dtotal + f * (Dmax / Bmax));
      const Ei = Di / r.price;
      const profit = Ei - Dtotal;
      return { id: r.id, Di, Ei, profit, pct: profit / Dtotal };
    });
  } else {
    // ── Free mode: user sets Dtotal; profit factors scale allocation ──────
    // Di = Bi*(Dtotal + F(i)*K),  K = Dtotal*(1-priceSum)/sum(F(i)*Bi)
    Dtotal = calc.total;
    Dmax   = null;

    const sumFB = active.reduce((s, r) => s + effectiveFactor(r) * r.price, 0);
    if (sumFB === 0) {
      // All factors 0 → proportional-to-price allocation, no profit guarantee
      results = active.map(r => {
        const Di = r.price * Dtotal;
        const Ei = Dtotal;
        const profit = Ei - Dtotal;
        return { id: r.id, Di, Ei, profit, pct: 0 };
      });
    } else {
      const K = Dtotal * (1 - priceSum) / sumFB;
      results = active.map(r => {
        const Di = r.price * (Dtotal + effectiveFactor(r) * K);
        const Ei = Di / r.price;
        const profit = Ei - Dtotal;
        return { id: r.id, Di, Ei, profit, pct: profit / Dtotal };
      });
    }
  }

  // EV = Σ(mid_i × profit_i) — probability-weighted expected profit
  const ev = results.reduce((s, r) => {
    const row = calc.rows.find(row => row.id === r.id);
    return s + (row?.mid ?? 0) * r.profit;
  }, 0);

  return { results, priceSum, Dtotal, Dmax, ev };
}

function calcApplyLinear() {
  const n = calc.rows.length;
  calc.rows.forEach((r, i) => { r.factor = n > 1 ? i / (n - 1) : 0; });
}

function calcApplyOdds() {
  const active = calc.rows.filter(r => r.included && r.price > 0);
  if (active.length < 2) return;
  const B0 = active[0].price, Bn = active[active.length - 1].price;
  const span = 1 / Bn - 1 / B0;
  if (span === 0) return;
  calc.rows.forEach(r => {
    if (!r.included || !r.price) return;
    r.factor = Math.min(1, Math.max(0, (1 / r.price - 1 / B0) / span));
  });
}

function calcAnchorId() {
  const active = calc.rows.filter(r => r.included);
  return active.length > 0 ? active[active.length - 1].id : null;
}

function renderCalcRows() {
  const tbody = document.getElementById("c-body");
  if (!tbody) return;

  const included = calc.rows.filter(r => r.included);

  // If anchorId no longer points to an included row, fall back to last included
  if (calc.anchorId !== null && !included.find(r => r.id === calc.anchorId)) {
    calc.anchorId = included.length > 0 ? included[included.length - 1].id : null;
    updateInputLabel();
  }

  // Ensure breakEvenId is valid when break-even is enabled
  if (calc.breakEvenEnabled) {
    const eligible = included.filter(r => r.id !== calc.anchorId);
    if (!eligible.find(r => r.id === calc.breakEvenId)) {
      calc.breakEvenId = calcMostLikelyId(eligible.length ? eligible : included);
    }
  }

  tbody.innerHTML = "";
  calc.rows.forEach(r => {
    const isAnchor    = calc.anchorId !== null && r.id === calc.anchorId && r.included;
    const isBreakEven = calc.breakEvenEnabled && r.id === calc.breakEvenId && r.included && !isAnchor;
    const tr = document.createElement("tr");
    tr.dataset.rid = r.id;
    if (!r.included) tr.className = "row-dim";

    let factorCell;
    if (isAnchor) {
      factorCell = `<span class="factor-anchor">1.00 — anchor</span>`;
    } else if (isBreakEven) {
      factorCell = `<span class="factor-be">0.00 — break-even</span>`;
    } else {
      factorCell = `<div class="slider-wrap">
        <input type="range" class="c-slider" min="0" max="1" step="0.01"
          value="${r.factor.toFixed(2)}" ${!r.included ? "disabled" : ""}>
        <span class="c-fval">${r.factor.toFixed(2)}</span>
      </div>`;
    }

    tr.innerHTML = `
      <td class="col-chk"><input type="checkbox" ${r.included ? "checked" : ""}></td>
      <td class="col-anc"><input type="radio" name="c-anc"
        ${isAnchor ? "checked" : ""}
        ${!r.included ? "disabled" : ""}></td>
      <td class="col-be"><input type="radio" name="c-be"
        ${isBreakEven ? "checked" : ""}
        ${!r.included || isAnchor ? "disabled" : ""}></td>
      <td class="col-label c-tier-label">${escHtml(r.label)}</td>
      <td class="num c-price">${fmt(r.price)}</td>
      <td class="c-factor-cell">${factorCell}</td>
      <td class="num c-invest">—</td>
      <td class="num c-payout">—</td>
      <td class="num c-profit">—</td>
      <td class="num c-return">—</td>
      <td class="num c-pos-entry muted">${r.position ? fmt(r.position.entry) : "—"}</td>
      <td class="num c-pos-shares muted">${r.position ? Math.round(r.position.invested / r.position.entry) : "—"}</td>
      <td class="num c-pos-invested muted">${r.position ? fmtUsd(r.position.invested) : "—"}</td>
      <td class="num c-pos-pnl muted">—</td>
    `;

    tr.querySelector("input[type='checkbox']").addEventListener("change", e => {
      r.included = e.target.checked;
      if (!r.included && r.id === calc.breakEvenId) calc.breakEvenId = null;
      if (!r.included && r.id === calc.anchorId) {
        const remaining = calc.rows.filter(rr => rr.included && rr.id !== r.id);
        calc.anchorId = remaining.length > 0 ? remaining[remaining.length - 1].id : null;
        updateInputLabel();
      }
      renderCalcRows();
    });

    tr.querySelector("input[name='c-anc']").addEventListener("change", () => {
      calc.anchorId = r.id;
      updateInputLabel();
      renderCalcRows();
    });

    tr.querySelector("input[name='c-be']").addEventListener("change", () => {
      calc.breakEvenId = r.id;
      calc.breakEvenEnabled = true;
      renderCalcRows();
    });

    const slider = tr.querySelector(".c-slider");
    if (slider) {
      slider.addEventListener("input", e => {
        r.factor = parseFloat(e.target.value);
        tr.querySelector(".c-fval").textContent = r.factor.toFixed(2);
        refreshCalc();
      });
    }

    tbody.appendChild(tr);
  });

  // Sync "none" radio states in thead
  const noneAnc = document.getElementById("c-anc-none");
  const noneBe  = document.getElementById("c-be-none");
  if (noneAnc) noneAnc.checked = (calc.anchorId === null);
  if (noneBe)  noneBe.checked  = !calc.breakEvenEnabled;

  refreshCalc();
}

function refreshCalc() {
  const tbody = document.getElementById("c-body");
  const tfoot = document.getElementById("c-foot");
  const warn  = document.getElementById("c-warn");
  if (!tbody || !tfoot || !warn) return;

  const res = runCalc();

  if (res.err) {
    warn.textContent = res.err;
    warn.hidden = false;
    tfoot.innerHTML = "";
    tbody.querySelectorAll("tr").forEach(tr => {
      ["c-invest","c-payout","c-profit","c-return"].forEach(cls => {
        const el = tr.querySelector("." + cls);
        if (el) { el.textContent = "—"; el.className = "num " + cls; }
      });
    });
    return;
  }

  warn.hidden = true;

  res.results.forEach(r => {
    const tr = tbody.querySelector(`tr[data-rid="${r.id}"]`);
    if (!tr) return;
    tr.querySelector(".c-invest").textContent = fmtEur(r.Di);
    tr.querySelector(".c-payout").textContent = fmtEur(r.Ei);
    const pr = tr.querySelector(".c-profit");
    pr.textContent = fmtEur(r.profit);
    pr.className = "num c-profit " + (r.profit >= 0 ? "bid" : "ask");
    const rt = tr.querySelector(".c-return");
    rt.textContent = fmtPct(r.pct);
    rt.className = "num c-return " + (r.pct >= 0 ? "bid" : "ask");
  });

  // Live P&L for all rows with a recorded position
  tbody.querySelectorAll("tr[data-rid]").forEach(tr => {
    const r = calc.rows.find(r => r.id === tr.dataset.rid);
    const pnlEl = tr.querySelector(".c-pos-pnl");
    if (!pnlEl || !r?.position) return;
    const pos = r.position;
    let pnl, pnlPct;
    if (pos.cashPnl != null && pos.percentPnl != null) {
      // Use pre-computed values from Polymarket API
      pnl    = pos.cashPnl;
      pnlPct = pos.percentPnl / 100;
    } else {
      // Fallback: compute from current bid for manual positions.env entries
      const shares = (pos.size ?? (pos.invested / pos.entry));
      pnl    = shares * (r.price || 0) - pos.invested;
      pnlPct = pnl / pos.invested;
    }
    pnlEl.textContent = `${fmtEur(pnl)} ${fmtPct(pnlPct)}`;
    pnlEl.className = "num c-pos-pnl " + (pnl >= 0 ? "bid" : "ask");
  });

  calcSaveState();

  const hasArb = res.priceSum < 1.0;
  const arbCls = hasArb ? "bid" : "ask";

  const totalInvested = (window._lastData?.positions || [])
    .reduce((s, p) => s + (p.invested || 0), 0);
  const totalPnl = (window._lastData?.positions || [])
    .reduce((s, p) => s + (p.cashPnl || 0), 0);
  const pnlCls = totalPnl >= 0 ? "bid" : "ask";

  tfoot.innerHTML = `
    <tr class="calc-foot">
      <td colspan="3"></td>
      <td class="num ${arbCls}" title="Sum of selected prices. < 100¢ = arb window open.">
        ${(res.priceSum * 100).toFixed(2)}¢
        <span class="foot-tag ${arbCls}">${hasArb ? "arb ✓" : "no arb"}</span>
      </td>
      <td></td>
      <td class="num">${res.Dmax != null ? fmtEur(res.Dmax) : "—"}
        <span class="foot-tag muted">${res.Dmax != null ? "anchor" : "free"}</span>
      </td>
      <td class="num muted">€${res.Dtotal.toFixed(2)}
        <span class="foot-tag muted">total</span>
      </td>
      <td colspan="3"></td>
      <td class="num" title="Total invested across all open SpaceX positions">
        ${totalInvested > 0 ? fmtUsd(totalInvested) : "—"}
        <span class="foot-tag muted">invested</span>
      </td>
      <td class="num ${pnlCls}" colspan="3" title="Total unrealized P&L from Polymarket">
        ${totalInvested > 0 ? fmtUsd(totalPnl) : "—"}
        <span class="foot-tag ${pnlCls}">${totalInvested > 0 ? ((totalPnl/totalInvested*100).toFixed(1)+'%') : ''}</span>
      </td>
    </tr>
  `;
}

function calcSyncPrices() {
  const ev = (window._lastData?.events || []).find(e => e.slug === calc.slug);
  if (!ev) return;
  calc.rows.forEach(r => {
    const m = ev.markets.find(m => m.id === r.id);
    if (m) {
      r.price = calcGetPrice(m) ?? r.price;
      r.mid   = calcMid(m);
    }
  });
  document.querySelectorAll("#c-body tr[data-rid]").forEach(tr => {
    const r = calc.rows.find(r => r.id === tr.dataset.rid);
    if (r) {
      r.position = findPosition(r.label);
      const el = tr.querySelector(".c-price");
      if (el) el.textContent = fmt(r.price);
    }
  });
  refreshCalc();
}

function calcMostLikelyId(rows) {
  // Most likely = highest price among included rows
  const included = rows.filter(r => r.included);
  if (!included.length) return null;
  return included.reduce((best, r) => r.price > best.price ? r : best, included[0]).id;
}

function calcLoadEvent(slug) {
  const ev = (window._lastData?.events || []).find(e => e.slug === slug);
  if (!ev) return;
  calc.slug = slug;
  const n = ev.markets.length;
  calc.rows = ev.markets.map((m, i) => ({
    id: m.id,
    label: m.label,
    price: calcGetPrice(m) ?? 0,
    mid: calcMid(m),
    included: true,
    factor: n > 1 ? i / (n - 1) : 0,
    position: findPosition(m.label),
  }));
  // Default anchor: last included row
  const lastIncl = calc.rows.filter(r => r.included);
  calc.anchorId = lastIncl.length > 0 ? lastIncl[lastIncl.length - 1].id : null;
  calc.breakEvenEnabled = true;
  calc.breakEvenId = calcMostLikelyId(calc.rows);

  // Restore saved per-row state when the slug matches
  const saved = calcRestoreState();
  if (saved && saved.slug === slug && saved.rows) {
    calc.rows.forEach(r => {
      const s = saved.rows[r.id];
      if (!s) return;
      r.included = Boolean(s.included);
      if (typeof s.factor === "number") r.factor = s.factor;
    });
    if (saved.breakEvenId && calc.rows.find(r => r.id === saved.breakEvenId && r.included)) {
      calc.breakEvenId = saved.breakEvenId;
    }
    if ("anchorId" in saved) {
      calc.anchorId = (saved.anchorId === null || calc.rows.find(r => r.id === saved.anchorId && r.included))
        ? saved.anchorId : calc.anchorId;
    }
    if ("breakEvenEnabled" in saved) calc.breakEvenEnabled = Boolean(saved.breakEvenEnabled);
  }

  updateInputLabel();
  renderCalcRows();
}

// ── Snapshots ──────────────────────────────────────────────────────────────

const SNAP_KEY = "kaiser-snapshots-v1";

function snapLoadAll() {
  try { return JSON.parse(localStorage.getItem(SNAP_KEY) || "[]"); } catch { return []; }
}

function snapSaveAll(snaps) {
  try { localStorage.setItem(SNAP_KEY, JSON.stringify(snaps)); } catch {}
}

function snapCreate() {
  const res = runCalc();
  const snaps = snapLoadAll();
  const now = new Date();
  const ev = (window._lastData?.events || []).find(e => e.slug === calc.slug);
  const eventLabel = ev ? ev.title : (calc.slug || "Unknown");
  const timestamp = now.toLocaleDateString() + " " +
    now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const name = eventLabel + " · " + timestamp;
  const snap = {
    id: now.getTime(),
    name,
    savedAt: now.toISOString(),
    slug: calc.slug,
    priceType: calc.priceType,
    total: calc.total,
    anchorId: calc.anchorId,
    breakEvenId: calc.breakEvenId,
    breakEvenEnabled: calc.breakEvenEnabled,
    rows: calc.rows.map(r => ({
      id: r.id, label: r.label, price: r.price, mid: r.mid,
      factor: r.factor, included: r.included,
    })),
    results: res.err ? null : {
      Dtotal: res.Dtotal, Dmax: res.Dmax,
      priceSum: res.priceSum,
      perRow: res.results.map(r => ({ id: r.id, Di: r.Di, Ei: r.Ei, profit: r.profit, pct: r.pct })),
    },
  };
  snaps.push(snap);
  snapSaveAll(snaps);
  return snap;
}

function snapApply(snap) {
  calc.slug             = snap.slug;
  calc.priceType        = snap.priceType;
  calc.total            = snap.total;
  calc.anchorId         = snap.anchorId !== undefined ? snap.anchorId
    : (snap.rows.length > 0 ? snap.rows[snap.rows.length - 1].id : null);
  calc.breakEvenId      = snap.breakEvenId;
  calc.breakEvenEnabled = snap.breakEvenEnabled !== undefined ? snap.breakEvenEnabled : true;
  calc.rows = snap.rows.map(r => ({ ...r, position: findPosition(r.label) }));
  updateInputLabel();
  const pxEl  = document.getElementById("c-px");
  const totEl = document.getElementById("c-total");
  const evtEl = document.getElementById("c-evt");
  if (pxEl)  pxEl.value  = snap.priceType;
  if (totEl) totEl.value = snap.total;
  if (evtEl) evtEl.value = snap.slug;
  renderCalcRows();
  // Overwrite computed cells with frozen snapshot values
  if (snap.results?.perRow) {
    const tbody = document.getElementById("c-body");
    snap.results.perRow.forEach(r => {
      const tr = tbody?.querySelector(`tr[data-rid="${r.id}"]`);
      if (!tr) return;
      tr.querySelector(".c-invest").textContent = fmtEur(r.Di);
      tr.querySelector(".c-payout").textContent = fmtEur(r.Ei);
      const pr = tr.querySelector(".c-profit");
      pr.textContent = fmtEur(r.profit);
      pr.className = "num c-profit " + (r.profit >= 0 ? "bid" : "ask");
      const rt = tr.querySelector(".c-return");
      rt.textContent = fmtPct(r.pct);
      rt.className = "num c-return " + (r.pct >= 0 ? "bid" : "ask");
    });
  }
}

function snapRefreshList() {
  const sel = document.getElementById("c-snap-list");
  if (!sel) return;
  const cur = sel.value;
  const snaps = snapLoadAll();
  sel.innerHTML = '<option value="">— load snapshot —</option>' +
    snaps.slice().reverse().map(s =>
      `<option value="${s.id}">${escHtml(s.name)}</option>`
    ).join("");
  if (cur) sel.value = cur;
}

function buildCalc(events) {
  const root = document.getElementById("calc-root");
  if (!root) return;

  if (!calc.built) {
    calc.built = true;
    root.innerHTML = `
      <section class="event-section calc-section">
        <div class="event-header">
          <div class="event-title-row">
            <h2 class="event-title">Tier Matrix Calculator</h2>
          </div>
          <div class="calc-controls">
            <label class="calc-ctrl-label">Event
              <select id="c-evt"></select>
            </label>
            <label class="calc-ctrl-label">Price
              <select id="c-px">
                <option value="bid">Bid</option>
                <option value="ask">Ask</option>
                <option value="mid">Mid</option>
              </select>
            </label>
            <label class="calc-ctrl-label" id="c-total-label"><span id="c-total-label-text">Anchor Investment</span>
              <div class="calc-inv-wrap">
                <span class="calc-inv-symbol">€</span>
                <input type="number" id="c-total" value="1000" min="1" step="100">
              </div>
            </label>
            <div class="calc-presets">
              <span class="calc-ctrl-label">Factors</span>
              <button id="c-linear" class="btn-preset">Linear</button>
              <button id="c-odds"   class="btn-preset">Odds-space</button>
            </div>
            <div class="calc-snap-bar">
              <button id="c-snap-save" class="btn-preset">Save snapshot</button>
              <select id="c-snap-list" class="calc-snap-sel">
                <option value="">— select snapshot —</option>
              </select>
              <button id="c-snap-load" class="btn-preset">Load</button>
              <button id="c-snap-del" class="btn-preset">Delete</button>
              <span class="snap-divider"></span>
              <button id="c-snap-live" class="btn-preset btn-live" hidden>↩ Live</button>
            </div>
          </div>
        </div>
        <div id="c-snap-banner" class="calc-snap-banner" hidden>
          <span id="c-snap-label"></span>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th class="col-chk">✓</th>
                <th class="col-anc" title="Anchor row (sets Dmax). Select none for free mode."><label><input type="radio" name="c-anc" id="c-anc-none"> Anc</label></th>
                <th class="col-be" title="Break-even row (profit = 0 if this wins). Select none to disable."><label><input type="radio" name="c-be" id="c-be-none"> BE</label></th>
                <th class="col-label">Tier</th>
                <th class="col-bid">Price</th>
                <th class="col-factor-h">Profit Factor</th>
                <th class="col-bid">Investment</th>
                <th class="col-ask">Payout</th>
                <th class="col-spread">Profit</th>
                <th class="col-mid">Return</th>
                <th class="col-pos-entry" title="Your actual entry price">Entry</th>
                <th class="col-pos-shares" title="Shares held = invested ÷ entry">Shares</th>
                <th class="col-pos-invested" title="USD invested in this tier">Invested</th>
                <th class="col-pos-pnl" title="Unrealized P&L at current bid">P&L</th>
              </tr>
            </thead>
            <tbody id="c-body"></tbody>
            <tfoot id="c-foot"></tfoot>
          </table>
        </div>
        <div id="c-warn" class="calc-warn" hidden></div>
      </section>
    `;

    document.getElementById("c-evt").addEventListener("change", e => {
      calcLoadEvent(e.target.value);
      calcSaveState();
    });

    document.getElementById("c-px").addEventListener("change", e => {
      calc.priceType = e.target.value;
      calcSyncPrices();
    });

    document.getElementById("c-total").addEventListener("input", e => {
      calc.total = Math.max(1, parseFloat(e.target.value) || 1000);
      refreshCalc();
    });

    document.getElementById("c-linear").addEventListener("click", () => {
      calcApplyLinear();
      renderCalcRows();
    });

    document.getElementById("c-odds").addEventListener("click", () => {
      calcApplyOdds();
      renderCalcRows();
    });

    document.getElementById("c-snap-save").addEventListener("click", () => {
      const snap = snapCreate();
      snapRefreshList();
      const sel = document.getElementById("c-snap-list");
      if (sel) sel.value = snap.id;
      const btn = document.getElementById("c-snap-save");
      const orig = btn.textContent;
      btn.textContent = "Saved ✓";
      setTimeout(() => { btn.textContent = orig; }, 1500);
    });

    document.getElementById("c-snap-load").addEventListener("click", () => {
      const sel  = document.getElementById("c-snap-list");
      if (!sel?.value) return;
      const snap = snapLoadAll().find(s => s.id === Number(sel.value));
      if (!snap) return;
      calc.snapshotMode = true;
      snapApply(snap);
      const banner  = document.getElementById("c-snap-banner");
      const label   = document.getElementById("c-snap-label");
      const liveBtn = document.getElementById("c-snap-live");
      if (banner)  banner.hidden  = false;
      if (label)   label.textContent = "Viewing snapshot: " + snap.name + " — prices frozen";
      if (liveBtn) liveBtn.hidden = false;
    });

    document.getElementById("c-snap-del").addEventListener("click", () => {
      const sel = document.getElementById("c-snap-list");
      if (!sel?.value) return;
      snapSaveAll(snapLoadAll().filter(s => s.id !== Number(sel.value)));
      sel.value = "";
      snapRefreshList();
      if (calc.snapshotMode) {
        calc.snapshotMode = false;
        const banner  = document.getElementById("c-snap-banner");
        const liveBtn = document.getElementById("c-snap-live");
        if (banner)  banner.hidden  = true;
        if (liveBtn) liveBtn.hidden = true;
        calcSyncPrices();
      }
    });

    document.getElementById("c-snap-live").addEventListener("click", () => {
      calc.snapshotMode = false;
      const banner  = document.getElementById("c-snap-banner");
      const liveBtn = document.getElementById("c-snap-live");
      const sel     = document.getElementById("c-snap-list");
      if (banner)  banner.hidden  = true;
      if (liveBtn) liveBtn.hidden = true;
      if (sel)     sel.value      = "";
      calcSyncPrices();
    });

    document.getElementById("c-anc-none").addEventListener("change", () => {
      calc.anchorId = null;
      updateInputLabel();
      renderCalcRows();
    });

    document.getElementById("c-be-none").addEventListener("change", () => {
      calc.breakEvenEnabled = false;
      calc.breakEvenId = null;
      renderCalcRows();
    });

    snapRefreshList();

    // Restore global settings from localStorage before loading event
    const saved = calcRestoreState();
    if (saved) {
      if (saved.priceType) {
        calc.priceType = saved.priceType;
        const pxEl = document.getElementById("c-px");
        if (pxEl) pxEl.value = saved.priceType;
      }
      if (saved.total >= 1) {
        calc.total = saved.total;
        const totEl = document.getElementById("c-total");
        if (totEl) totEl.value = saved.total;
      }
    }

    // Load saved event or fall back to first
    const targetSlug = (saved?.slug && events.find(e => e.slug === saved.slug))
      ? saved.slug
      : (events.length > 0 ? events[0].slug : null);
    if (targetSlug) calcLoadEvent(targetSlug);
  }

  // Update event selector options (in case events changed)
  const sel = document.getElementById("c-evt");
  if (sel) {
    const prev = sel.value || calc.slug;
    sel.innerHTML = events.map(ev =>
      `<option value="${escHtml(ev.slug)}">${escHtml(ev.title)}</option>`
    ).join("");
    if (prev && events.find(e => e.slug === prev)) sel.value = prev;
  }

  // Sync live prices without disturbing user's factor settings (skip in snapshot mode)
  if (calc.slug && !calc.snapshotMode) calcSyncPrices();
}
