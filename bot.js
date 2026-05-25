#!/usr/bin/env node

const fs     = require("fs");
const fsp    = require("fs/promises");
const http   = require("http");
const path   = require("path");
const crypto = require("crypto");

function loadEnvFile(filePath = path.join(process.cwd(), ".env")) {
  try {
    if (!fs.existsSync(filePath)) return;
    const raw = fs.readFileSync(filePath, "utf8");
    raw.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const eq = trimmed.indexOf("=");
      if (eq === -1) return;
      const key = trimmed.slice(0, eq).trim();
      if (!key || process.env[key] !== undefined) return;
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    });
  } catch (err) {
    console.warn("[bot] Failed to load .env:", err.message || err);
  }
}

loadEnvFile();

const DEFAULT_CONFIG = {
  port: 3001,
  pollSeconds: 20,
  requestTimeoutMs: 12000,
  gammaBaseUrl: "https://gamma-api.polymarket.com",
  eventSlugs: [
    "spacex-ipo-closing-market-cap",
    "spacex-ipo-closing-market-cap-lowest-strikes",
    "spacex-ipo-closing-market-cap-above",
    "spacex-ipo-closing-market-cap-higher-strikes",
  ],
};

const PUBLIC_DIR = path.join(process.cwd(), "public");
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

const state = {
  startedAt: Date.now(),
  lastFetchAt: null,
  lastError: "",
  fetchCount: 0,
  pollInFlight: false,
  events: [],
  fetchedAt: null,
  openOrders: [],
};

const HISTORY_DAYS   = 7;
const HISTORY_SAMPLE = 80;
const HISTORY_FILE   = path.join(process.cwd(), "cache", "price-history.json");
const RESOLVED_FILE  = path.join(process.cwd(), "cache", "resolved.json");
const CONFIG_FILE    = process.env.BOT_CONFIG || path.join(process.cwd(), "bot.config.json");

// { [marketId]: [{t: timestampMs, b: bestBid}] }
const priceHistory = {};

// { [marketId]: { value: number|null, ts: timestampMs } }
const priceChange24hCache = {};

let resolvedEvents  = [];   // persisted to RESOLVED_FILE
let lastEventActive = null; // null until first poll; { [slug]: boolean }

let appConfig = null;
let server = null;
let pollTimer = null;
let isShuttingDown = false;

function loadConfig() {
  const configPath = process.env.BOT_CONFIG || path.join(process.cwd(), "bot.config.json");
  let fileConfig = {};

  try {
    if (fs.existsSync(configPath)) {
      fileConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    }
  } catch (err) {
    throw new Error(`Failed to parse ${configPath}: ${err.message || err}`);
  }

  const port = Number(process.env.BOT_PORT || fileConfig.port || DEFAULT_CONFIG.port);
  const pollSeconds = Number(fileConfig.pollSeconds || DEFAULT_CONFIG.pollSeconds);
  const requestTimeoutMs = Number(fileConfig.requestTimeoutMs || DEFAULT_CONFIG.requestTimeoutMs);
  const gammaBaseUrl = String(fileConfig.gammaBaseUrl || DEFAULT_CONFIG.gammaBaseUrl).replace(/\/+$/, "");
  const eventSlugs = Array.isArray(fileConfig.eventSlugs)
    ? fileConfig.eventSlugs
    : DEFAULT_CONFIG.eventSlugs;

  // config file wins over env var so UI-driven "clear" persists even if env still has a value
  return {
    port: Math.trunc(Math.max(1, Math.min(65535, port))),
    pollSeconds: Math.trunc(Math.max(5, Math.min(3600, pollSeconds))),
    requestTimeoutMs: Math.trunc(Math.max(1000, Math.min(120000, requestTimeoutMs))),
    gammaBaseUrl,
    eventSlugs,
  };
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`HTTP ${response.status} from ${url} | ${body.slice(0, 300)}`);
    }
    return await response.json();
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function parseLabelSortKey(label) {
  const s = String(label || "").trim();
  if (!s || /no.?ipo/i.test(s)) return Infinity;

  // ">$1.4T", ">1T", etc.
  const aboveMatch = s.match(/^>[\s$]*([0-9.]+)\s*([TB])/i);
  if (aboveMatch) return parseFloat(aboveMatch[1]) * (aboveMatch[2].toUpperCase() === "T" ? 1e12 : 1e9);

  // "<500B", "<1.0T"
  const belowMatch = s.match(/^<[\s$]*([0-9.]+)\s*([TB])/i);
  if (belowMatch) return 0;

  // "1.5T-2.0T", "500B–600B", "1.5T–2.0T"
  const rangeMatch = s.match(/^([0-9.]+)\s*([TB])[\s\-–]/i);
  if (rangeMatch) return parseFloat(rangeMatch[1]) * (rangeMatch[2].toUpperCase() === "T" ? 1e12 : 1e9);

  // "3.5T+", "1T+"
  const plusMatch = s.match(/^([0-9.]+)\s*([TB])\s*\+/i);
  if (plusMatch) return parseFloat(plusMatch[1]) * (plusMatch[2].toUpperCase() === "T" ? 1e12 : 1e9);

  return null;
}

function parseJsonField(val, fallback) {
  if (Array.isArray(val)) return val;
  if (typeof val === "string") {
    try {
      return JSON.parse(val);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function toNum(val) {
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function extractMarket(m) {
  const outcomes = parseJsonField(m.outcomes, ["Yes", "No"]);
  const outcomePrices = parseJsonField(m.outcomePrices, [null, null]).map(toNum);

  return {
    id: String(m.id || ""),
    slug: String(m.slug || ""),
    question: String(m.question || ""),
    label: String(m.groupItemTitle || m.question || ""),
    rangeLow: parseLabelSortKey(m.groupItemTitle || m.question),
    outcomes,
    outcomePrices,
    bestBid: toNum(m.bestBid),
    bestAsk: toNum(m.bestAsk),
    spread: toNum(m.spread),
    lastTradePrice: toNum(m.lastTradePrice),
    priceChange24h: toNum(m.oneDayPriceChange),  // Gamma API field; null = fetch from CLOB
    volume24hr: toNum(m.volume24hr),
    liquidity: toNum(m.liquidityNum ?? m.liquidity),
    active: Boolean(m.active),
    closed: Boolean(m.closed),
    negRisk: Boolean(m.negRisk),
    clobTokenIds: parseJsonField(m.clobTokenIds, []),
  };
}

function extractEvent(ev) {
  const markets = (Array.isArray(ev.markets) ? ev.markets.map(extractMarket) : [])
    .sort((a, b) => {
      const ar = a.rangeLow;
      const br = b.rangeLow;
      if (ar == null && br == null) return 0;
      if (ar == null) return 1;
      if (br == null) return -1;
      return ar - br;
    });
  return {
    id: String(ev.id || ""),
    slug: String(ev.slug || ""),
    title: String(ev.title || ""),
    active: Boolean(ev.active),
    closed: Boolean(ev.closed),
    negRisk: Boolean(ev.negRisk),
    liquidity: toNum(ev.liquidity),
    volume24hr: toNum(ev.volume24hr),
    markets,
  };
}

async function fetchEvent(slug) {
  const url = `${appConfig.gammaBaseUrl}/events?slug=${encodeURIComponent(slug)}`;
  const data = await fetchJsonWithTimeout(url, appConfig.requestTimeoutMs);
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`No event found for slug: ${slug}`);
  }
  return extractEvent(data[0]);
}


function mapPositions(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const trackedSlugs = new Set(appConfig.eventSlugs);
  const relevant = list.filter(p => trackedSlugs.has(p.eventSlug));

  const tokenMap = new Map();
  for (const ev of state.events) {
    for (const m of ev.markets) {
      for (const tokenId of m.clobTokenIds) {
        tokenMap.set(String(tokenId), m.label);
      }
    }
  }

  const positions = [];
  for (const pos of relevant) {
    const label = tokenMap.get(String(pos.asset ?? ""));
    if (!label) continue;
    const size     = parseFloat(pos.size);
    const avgPrice = parseFloat(pos.avgPrice);
    if (!Number.isFinite(size) || size <= 0)        continue;
    if (!Number.isFinite(avgPrice) || avgPrice <= 0) continue;
    positions.push({
      tier:       label,
      entry:      avgPrice,
      size,
      invested:   +(size * avgPrice).toFixed(2),
      cashPnl:    pos.cashPnl    ?? null,
      percentPnl: pos.percentPnl ?? null,
    });
  }
  return positions;
}

async function fetchOpenOrders() {
  const address    = (process.env.POLYMARKET_ADDRESS    || "").trim().toLowerCase();
  const apiKey     = (process.env.POLYMARKET_API_KEY    || "").trim();
  const secret     = (process.env.POLYMARKET_SECRET     || "").trim();
  const passphrase = (process.env.POLYMARKET_PASSPHRASE || "").trim();
  if (!apiKey || !secret || !passphrase || !address) return [];

  const qs        = `owner=${encodeURIComponent(address)}&status=LIVE`;
  const path_     = `/orders?${qs}`;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = crypto.createHmac("sha256", secret)
    .update(timestamp + "GET" + path_)
    .digest("base64");

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), appConfig.requestTimeoutMs);
  try {
    const res = await fetch(`https://clob.polymarket.com${path_}`, {
      headers: {
        "POLY_ADDRESS":    address,
        "POLY_API_KEY":    apiKey,
        "POLY_PASSPHRASE": passphrase,
        "POLY_TIMESTAMP":  timestamp,
        "POLY_SIGNATURE":  signature,
        "Accept":          "application/json",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data   = await res.json();
    const orders = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);

    // Build token → market map
    const tokenMap = new Map();
    for (const ev of state.events) {
      for (const m of ev.markets) {
        for (const tokenId of m.clobTokenIds) {
          tokenMap.set(String(tokenId), { label: m.label, id: m.id });
        }
      }
    }

    const result = [];
    for (const o of orders) {
      const market = tokenMap.get(String(o.asset_id ?? ""));
      if (!market) continue;
      const price    = parseFloat(o.price);
      const size     = parseFloat(o.original_size ?? o.size ?? 0);
      const filled   = parseFloat(o.size_matched ?? 0);
      const remaining = size - filled;
      if (!Number.isFinite(price) || remaining <= 0) continue;
      result.push({
        marketId:  market.id,
        label:     market.label,
        side:      String(o.side || "").toUpperCase(),
        price,
        size,
        filled,
        remaining: +remaining.toFixed(2),
      });
    }

    if (result.length > 0) console.log(`[bot] ${result.length} open orders`);
    return result;
  } catch (err) {
    if (err.name !== "AbortError") console.warn("[bot] Failed to fetch open orders:", err.message);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function loadPriceHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return;
    const raw = fs.readFileSync(HISTORY_FILE, "utf8");
    const data = JSON.parse(raw);
    const cutoff = Date.now() - HISTORY_DAYS * 864e5;
    for (const [id, pts] of Object.entries(data)) {
      const valid = pts.filter(p => p.t >= cutoff && typeof p.b === "number");
      if (valid.length > 0) priceHistory[id] = valid;
    }
    console.log(`[bot] Loaded price history for ${Object.keys(priceHistory).length} markets`);
  } catch (err) {
    console.warn("[bot] Failed to load price history:", err.message);
  }
}

function savePriceHistory() {
  fsp.mkdir(path.dirname(HISTORY_FILE), { recursive: true })
    .then(() => fsp.writeFile(HISTORY_FILE, JSON.stringify(priceHistory)))
    .catch(err => console.warn("[bot] Failed to save price history:", err.message));
}

function downsampleHistory() {
  const cutoff = Date.now() - HISTORY_DAYS * 864e5;
  const result = {};
  for (const [id, pts] of Object.entries(priceHistory)) {
    const recent = pts.filter(p => p.t >= cutoff);
    if (recent.length === 0) continue;
    if (recent.length <= HISTORY_SAMPLE) {
      result[id] = recent.map(p => p.b);
    } else {
      const sampled = [];
      for (let i = 0; i < HISTORY_SAMPLE; i++) {
        const idx = Math.round((i / (HISTORY_SAMPLE - 1)) * (recent.length - 1));
        sampled.push(recent[idx].b);
      }
      result[id] = sampled;
    }
  }
  return result;
}

function recordPriceHistory(events) {
  const now = Date.now();
  const cutoff = now - HISTORY_DAYS * 864e5;
  for (const ev of events) {
    for (const m of ev.markets) {
      if (m.bestBid == null) continue;
      if (!priceHistory[m.id]) priceHistory[m.id] = [];
      priceHistory[m.id].push({ t: now, b: m.bestBid });
      // Prune entries older than HISTORY_DAYS
      if (priceHistory[m.id][0]?.t < cutoff) {
        priceHistory[m.id] = priceHistory[m.id].filter(p => p.t >= cutoff);
      }
    }
  }
  savePriceHistory();
}

async function fetch24hChanges(events) {
  const now = Date.now();
  const TTL = 3_600_000; // re-fetch CLOB history once per hour

  const toFetch = [];
  for (const ev of events) {
    for (const m of ev.markets) {
      if (m.priceChange24h != null) continue; // Gamma API already provided it
      const cached = priceChange24hCache[m.id];
      if (cached && (now - cached.ts) < TTL) {
        m.priceChange24h = cached.value;
      } else {
        toFetch.push(m);
      }
    }
  }

  if (toFetch.length === 0) return;

  await Promise.allSettled(toFetch.map(async m => {
    const tokenId = m.clobTokenIds?.[0];
    if (!tokenId) return;
    try {
      const url = `https://clob.polymarket.com/prices-history?market=${encodeURIComponent(tokenId)}&interval=1d&fidelity=10`;
      const data = await fetchJsonWithTimeout(url, appConfig.requestTimeoutMs);
      const history = Array.isArray(data?.history) ? data.history : [];
      let value = null;
      if (history.length >= 2) {
        const p0 = Number(history[0].p);
        const p1 = Number(history[history.length - 1].p);
        if (p0 > 0) value = (p1 - p0) / p0;
      }
      priceChange24hCache[m.id] = { value, ts: now };
      m.priceChange24h = value;
    } catch {
      priceChange24hCache[m.id] = { value: null, ts: now };
    }
  }));
  const fetched = toFetch.filter(m => m.priceChange24h != null).length;
  if (fetched > 0) console.log(`[bot] 24h changes fetched for ${fetched}/${toFetch.length} markets`);
}

function loadResolved() {
  try {
    if (!fs.existsSync(RESOLVED_FILE)) return;
    resolvedEvents = JSON.parse(fs.readFileSync(RESOLVED_FILE, "utf8"));
    console.log(`[bot] Loaded ${resolvedEvents.length} resolved event(s)`);
  } catch (err) {
    console.warn("[bot] Failed to load resolved events:", err.message);
  }
}

function saveResolved() {
  fsp.mkdir(path.dirname(RESOLVED_FILE), { recursive: true })
    .then(() => fsp.writeFile(RESOLVED_FILE, JSON.stringify(resolvedEvents, null, 2)))
    .catch(err => console.warn("[bot] Failed to save resolved events:", err.message));
}

function recordResolution(ev) {
  resolvedEvents.push({
    slug:       ev.slug,
    title:      ev.title,
    resolvedAt: new Date().toISOString(),
    markets:    ev.markets.map(m => ({
      id:            m.id,
      label:         m.label,
      outcomes:      m.outcomes,
      outcomePrices: m.outcomePrices,
    })),
    positions: [],
  });
  console.log(`[bot] Recorded resolution: ${ev.slug}`);
}

function checkResolutions(events) {
  let changed = false;
  const isFirst = lastEventActive === null;
  if (isFirst) lastEventActive = {};

  for (const ev of events) {
    const isActive = ev.active && !ev.closed;
    const wasActive = isFirst ? isActive : (lastEventActive[ev.slug] ?? true);

    // Record if just closed, or (on first poll) already closed and unrecorded
    if (!isActive && ((!isFirst && wasActive) || (isFirst && !resolvedEvents.find(r => r.slug === ev.slug)))) {
      recordResolution(ev);
      changed = true;
    }
    lastEventActive[ev.slug] = isActive;
  }

  if (changed) saveResolved();
}

let pollDoneResolvers = [];

async function pollEvents() {
  if (state.pollInFlight) {
    // A poll is already running; wait for it to finish, then run another
    // so the caller gets fresh data with any config changes applied.
    await new Promise(resolve => pollDoneResolvers.push(resolve));
    return pollEvents();
  }
  state.pollInFlight = true;
  const started = Date.now();

  try {
    const results = await Promise.allSettled(
      appConfig.eventSlugs.map((slug) => fetchEvent(slug))
    );

    const events = [];
    const errors = [];

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "fulfilled") {
        events.push(r.value);
      } else {
        errors.push(`${appConfig.eventSlugs[i]}: ${r.reason?.message || r.reason}`);
      }
    }

    state.events = events;
    recordPriceHistory(events);
    const [, ord] = await Promise.all([
      fetch24hChanges(events),   // mutates market objects in-place; result discarded
      fetchOpenOrders(),
    ]);
    state.openOrders = ord;
    checkResolutions(events);
    state.fetchedAt = new Date().toISOString();
    state.lastFetchAt = state.fetchedAt;
    state.fetchCount += 1;
    state.lastError = errors.length > 0 ? errors.join("; ") : "";

    const totalMarkets = events.reduce((n, ev) => n + ev.markets.length, 0);
    const durationMs = Date.now() - started;
    console.log(
      `[bot] ${state.fetchedAt} poll #${state.fetchCount} events=${events.length}/${appConfig.eventSlugs.length} markets=${totalMarkets} durationMs=${durationMs}${errors.length ? ` errors=${errors.join("; ")}` : ""}`
    );
  } catch (err) {
    state.lastError = String(err.message || err);
    console.error("[bot] poll failed:", state.lastError);
  } finally {
    state.pollInFlight = false;
    const resolvers = pollDoneResolvers.splice(0);
    resolvers.forEach(r => r());
  }
}

function checkAdminAuth(req) {
  const token = (process.env.ADMIN_TOKEN || "").trim();
  if (!token) return true; // no token configured = open (local dev)
  return req.headers["authorization"] === `Bearer ${token}`;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(`${body}\n`);
}

function sendFile(res, filePath, body) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
  res.end(body);
}

async function tryServePublicFile(res, requestedPath) {
  const relativePath = requestedPath === "/" ? "index.html" : requestedPath.replace(/^\/+/, "");
  if (relativePath.includes("\0")) return false;

  const filePath = path.normalize(path.join(PUBLIC_DIR, relativePath));
  if (!filePath.startsWith(path.normalize(PUBLIC_DIR + path.sep))) return false;

  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return false;
    const body = await fsp.readFile(filePath);
    sendFile(res, filePath, body);
    return true;
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return false;
    throw err;
  }
}

function createServer() {
  return http.createServer(async (req, res) => {
    const method = req.method || "GET";
    const host = req.headers.host || `localhost:${appConfig.port}`;
    const url = new URL(req.url || "/", `http://${host}`);
    const pathname = url.pathname;

    try {
      if (method === "GET" && pathname === "/") {
        const served = await tryServePublicFile(res, "/");
        if (!served) sendJson(res, 404, { error: "index.html not found" });
        return;
      }

      if (method === "GET" && pathname.startsWith("/public/")) {
        const served = await tryServePublicFile(res, pathname.slice("/public".length));
        if (!served) sendJson(res, 404, { error: "Asset not found" });
        return;
      }

      if (method === "GET" && pathname === "/data") {
        return sendJson(res, 200, {
          events:      state.events,
          fetchedAt:   state.fetchedAt,
          pollSeconds: appConfig.pollSeconds,
          fetchCount:  state.fetchCount,
          priceHistory: downsampleHistory(),
          openOrders:  state.openOrders,
          resolved:    resolvedEvents,
          slugs:       appConfig.eventSlugs,
        });
      }

      if (method === "GET" && pathname === "/positions") {
        const qs = new URL(req.url, "http://localhost").searchParams;
        const address = (qs.get("address") || "").trim();
        if (!address) return sendJson(res, 200, []);
        try {
          const url = `https://data-api.polymarket.com/positions?user=${encodeURIComponent(address)}&sizeThreshold=0&limit=500`;
          const raw = await fetchJsonWithTimeout(url, appConfig.requestTimeoutMs);
          return sendJson(res, 200, mapPositions(raw));
        } catch (err) {
          return sendJson(res, 502, { error: err.message });
        }
      }

      if (method === "POST" && pathname === "/slugs") {
        if (!checkAdminAuth(req)) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
        let body = "";
        req.on("data", chunk => { body += chunk.toString(); });
        req.on("end", async () => {
          try {
            const { slugs } = JSON.parse(body);
            if (!Array.isArray(slugs)) return sendJson(res, 400, { error: "slugs must be an array" });
            const cleaned = [...new Set(slugs.map(s => String(s || "").trim()).filter(Boolean))];
            if (cleaned.length === 0) return sendJson(res, 400, { error: "at least one slug required" });
            appConfig.eventSlugs = cleaned;
            try {
              const cur = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) : {};
              cur.eventSlugs = cleaned;
              fs.writeFileSync(CONFIG_FILE, JSON.stringify(cur, null, 2));
            } catch (e) {
              console.warn("[bot] Could not persist slugs to config:", e.message);
            }
            await pollEvents().catch(e => console.error("[poll] error after slug change:", e.message));
            return sendJson(res, 200, { ok: true, slugs: cleaned });
          } catch (e) {
            return sendJson(res, 400, { error: e.message });
          }
        });
        return;
      }

      if (method === "GET" && pathname === "/health") {
        return sendJson(res, 200, {
          ok: !state.lastError,
          startedAt: new Date(state.startedAt).toISOString(),
          uptimeSeconds: Math.floor((Date.now() - state.startedAt) / 1000),
          lastFetchAt: state.lastFetchAt,
          pollInFlight: state.pollInFlight,
          fetchCount: state.fetchCount,
          lastError: state.lastError,
          eventSlugs: appConfig.eventSlugs,
          pollSeconds: appConfig.pollSeconds,
        });
      }

      if (method === "GET" && pathname === "/explore/scan") {
        const qs = new URL(req.url, "http://localhost").searchParams;
        const minTiers = Math.max(2, parseInt(qs.get("minTiers") || "5", 10));
        const pattern  = ["all","normal","extremes"].includes(qs.get("pattern")) ? qs.get("pattern") : "all";

        function classifyDist(prices) {
          const n = prices.length;
          const maxP = Math.max(...prices);
          const maxIdx = prices.indexOf(maxP);
          const head = prices[0], tail = prices[n - 1];
          const TAIL_THR = 0.08;
          if (head < TAIL_THR && tail < TAIL_THR) return "extremes";
          if (maxIdx > 0 && maxIdx < n - 1 && head < maxP * 0.65 && tail < maxP * 0.65) return "normal";
          return "other";
        }

        function evToResult(ev) {
          const markets = ev.markets || [];
          const prices = markets.map(m => {
            const op = parseJsonField(m.outcomePrices, []);
            return Number(op[0]);
          }).filter(p => p > 0 && p < 1);
          if (prices.length < minTiers) return null;
          // Skip all-identical (uninitialised) or all-resolved
          if (prices.every(p => Math.abs(p - prices[0]) < 0.005)) return null;
          if (prices.every(p => p < 0.01 || p > 0.99)) return null;
          const dist = classifyDist(prices);
          if (pattern !== "all" && dist !== pattern) return null;
          const sumP = prices.reduce((a, b) => a + b, 0);

          // Tags: skip internal/operational labels
          const skipTag = /hide|earn \d+%|forceHide|recurring/i;
          const tags = (ev.tags || [])
            .filter(t => !skipTag.test(t.label) && !t.forceHide)
            .map(t => t.label)
            .slice(0, 6);

          // Detect catch-all / "none of these" style option among market labels
          const noneRe = /\b(none|field|other|someone else|neither|no \w|n\/a|something else|not listed)\b/i;
          const allLabels = markets.map(m => String(m.groupItemTitle || m.question || ""));
          const hasNone = allLabels.some(l => noneRe.test(l));

          return {
            title: ev.title || ev.slug,
            slug: ev.slug,
            endDate: ev.endDate || null,
            closed: ev.closed === true,
            tierCount: prices.length,
            sumP: Math.round(sumP * 1000) / 1000,
            dist,
            prices: prices.map(p => Math.round(p * 1000) / 1000),
            tags,
            hasNone,
          };
        }

        // Primary sweep: all active negRisk events (elections, sports, IPO, temperature, crypto)
        // negRisk=true&closed=false covers ~9400 events = 95 pages
        const negRiskPages = 95;
        const negRiskUrls = Array.from({ length: negRiskPages }, (_, i) =>
          `${appConfig.gammaBaseUrl}/events?limit=100&offset=${i * 100}&negRisk=true&closed=false&order=volume&ascending=false`);

        // Secondary sweep: recent events by date (catches non-negRisk multi-tier markets)
        const datePages = 30;
        const dateUrls = Array.from({ length: datePages }, (_, i) =>
          `${appConfig.gammaBaseUrl}/events?limit=100&offset=${i * 100}&order=startDate&ascending=false`);

        const trackedUrls = appConfig.eventSlugs.map(s =>
          `${appConfig.gammaBaseUrl}/events?slug=${encodeURIComponent(s)}`);

        const allPageUrls = [...negRiskUrls, ...dateUrls];
        const [pageResults, trackedResults] = await Promise.all([
          Promise.allSettled(allPageUrls.map(url => fetchJsonWithTimeout(url, appConfig.requestTimeoutMs * 2))),
          Promise.allSettled(trackedUrls.map(url => fetchJsonWithTimeout(url, appConfig.requestTimeoutMs))),
        ]);

        const seen = new Set();
        const results = [];

        // Tracked events first (guaranteed inclusion)
        for (const tr of trackedResults) {
          if (tr.status !== "fulfilled") continue;
          const ev = Array.isArray(tr.value) ? tr.value[0] : tr.value;
          if (!ev?.slug || seen.has(ev.slug)) continue;
          const r = evToResult(ev);
          if (r) { seen.add(ev.slug); results.push({ ...r, tracked: true }); }
        }

        // Paginated sweep (deduplicated)
        for (const page of pageResults) {
          if (page.status !== "fulfilled" || !Array.isArray(page.value)) continue;
          for (const ev of page.value) {
            if (!ev?.slug || seen.has(ev.slug)) continue;
            const r = evToResult(ev);
            if (r) { seen.add(ev.slug); results.push(r); }
          }
        }

        results.sort((a, b) => a.sumP - b.sumP);
        return sendJson(res, 200, results.slice(0, 4000));
      }

      if (method === "GET" && pathname === "/explore") {
        const qs = new URL(req.url, "http://localhost").searchParams;
        const slug = (qs.get("slug") || "").trim();
        const interval = ["1d","1w","1m","max"].includes(qs.get("interval")) ? qs.get("interval") : "max";
        const fidelity = Math.min(500, Math.max(50, parseInt(qs.get("fidelity") || "200", 10)));
        if (!slug) return sendJson(res, 400, { error: "slug required" });
        try {
          const evUrl = `${appConfig.gammaBaseUrl}/events?slug=${encodeURIComponent(slug)}`;
          const evData = await fetchJsonWithTimeout(evUrl, appConfig.requestTimeoutMs);
          const ev = Array.isArray(evData) ? evData[0] : evData;
          if (!ev) return sendJson(res, 404, { error: "Event not found" });
          const markets = (ev.markets || []).map(m => {
            const outcomePrices = parseJsonField(m.outcomePrices, []);
            const yesPrice = Number(outcomePrices[0]);
            return {
              id: m.id,
              label: String(m.groupItemTitle || m.question || m.id),
              clobTokenIds: parseJsonField(m.clobTokenIds, []),
              resolved: m.closed === true,
              won: yesPrice === 1,
            };
          });
          const history = {};
          await Promise.allSettled(markets.map(async m => {
            const tokenId = m.clobTokenIds[0];
            if (!tokenId) return;
            try {
              const url = `https://clob.polymarket.com/prices-history?market=${encodeURIComponent(tokenId)}&interval=${interval}&fidelity=${fidelity}`;
              const data = await fetchJsonWithTimeout(url, appConfig.requestTimeoutMs * 2);
              history[m.id] = (data.history || []).map(h => ({ t: Number(h.t), p: Number(h.p) }));
            } catch { history[m.id] = []; }
          }));
          return sendJson(res, 200, { event: { title: ev.title, slug: ev.slug, markets }, history });
        } catch (err) {
          return sendJson(res, 502, { error: err.message });
        }
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      console.error("[bot] Request error:", err.message || err);
      sendJson(res, 500, { error: "Internal server error" });
    }
  });
}

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[bot] ${signal} received. Shutting down…`);
  if (pollTimer) clearInterval(pollTimer);
  if (server) await new Promise((resolve) => server.close(resolve));
  process.exit(0);
}

async function main() {
  appConfig = loadConfig();

  console.log(`[bot] Starting SpaceX IPO market cap dashboard`);
  console.log(`[bot] Tracking ${appConfig.eventSlugs.length} events, polling every ${appConfig.pollSeconds}s`);
  if (!(process.env.ADMIN_TOKEN || "").trim()) {
    console.warn("[bot] WARNING: ADMIN_TOKEN not set — /slugs endpoint is unprotected");
  }

  loadPriceHistory();
  loadResolved();
  server = createServer();
  await new Promise((resolve) => server.listen(appConfig.port, resolve));
  console.log(`[bot] HTTP server listening on http://localhost:${appConfig.port}`);

  await pollEvents();
  pollTimer = setInterval(pollEvents, appConfig.pollSeconds * 1000);
}

process.on("SIGINT", () => shutdown("SIGINT").catch(() => process.exit(1)));
process.on("SIGTERM", () => shutdown("SIGTERM").catch(() => process.exit(1)));

main().catch((err) => {
  console.error("[bot] Fatal startup error:", err.message || err);
  process.exit(1);
});
