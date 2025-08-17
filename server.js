/* eslint-disable no-console */
"use strict";

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { LRUCache } = require("lru-cache");

const app = express();

/* ========================== CONFIG ========================== */

const PORT = process.env.PORT || 3000;

// Single bases (optional overrides)
const INVIDIOUS_BASE = process.env.INVIDIOUS_BASE || "https://yewtu.be";
const PIPED_BASE     = process.env.PIPED_BASE     || "https://pipedapi.kavin.rocks";

// Pools (comma-separated envs), or robust defaults
const parsePool = (envVar, fallback) =>
  (process.env[envVar]?.split(",").map(s => s.trim()).filter(Boolean) || fallback);

const INVIDIOUS_POOL = parsePool("INVIDIOUS_POOL", [
  INVIDIOUS_BASE,
  "https://invidious.fdn.fr",
  "https://vid.puffyan.us",
  "https://iv.ggtyler.dev",
  "https://inv.nadeko.net",
  "https://invidious.nerdvpn.de"
]);

const PIPED_POOL = parsePool("PIPED_POOL", [
  PIPED_BASE,
  "https://piped.video",
  "https://piped.mha.fi",
  "https://pipedapi.adminforge.de",
  "https://piped.api.garudalinux.org",
  "https://piped.frontendfriendly.xyz"
]);

// Suggest locale (optional)
const SUGGEST_HL = process.env.SUGGEST_HL || "en";
const SUGGEST_GL = process.env.SUGGEST_GL || "US";

// Timeouts & cache
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 3500);
const CACHE_TTL_S         = Number(process.env.CACHE_TTL_S || 600);
const CACHE_MAX           = Number(process.env.CACHE_MAX || 2000);

/* ======================== MIDDLEWARE ======================== */

app.set("trust proxy", 1);
app.use(cors());
app.use(rateLimit({ windowMs: 60_000, max: 120 }));
app.get("/healthz", (_, res) => res.json({ ok: true }));

/* =========================== CACHE ========================== */

const respCache = new LRUCache({ max: CACHE_MAX, ttl: CACHE_TTL_S * 1000 });

function sendJson(res, key, payload, status = 200) {
  const body = JSON.stringify(payload);
  respCache.set(key, { status, body });
  res.status(status).type("application/json").send(body);
}

async function fetchText(url, timeoutMs = UPSTREAM_TIMEOUT_MS, headers = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        ...headers
      },
      redirect: "follow",
      signal: ctrl.signal
    });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

async function fetchJson(url, timeoutMs = UPSTREAM_TIMEOUT_MS, headers = {}) {
  const txt = await fetchText(url, timeoutMs, { accept: "application/json", ...headers });
  try { return JSON.parse(txt); } catch { return JSON.parse(txt.replace(/^\uFEFF/, "")); }
}

async function getCached(key, fn) {
  const hit = respCache.get(key);
  if (hit) return hit.value;
  const value = await fn();
  respCache.set(key, { value }, { ttl: CACHE_TTL_S * 1000 });
  return value;
}

// race a set of promises, ignoring rejections (first success wins)
async function firstResolved(promises) {
  return Promise.any(promises.map(p => p.catch(() => { throw Symbol("fail"); })));
}

/* ========================= NORMALIZERS ====================== */

const normalizeVideo = (v) => ({
  id: v.videoId ?? v.id ?? null,
  title: v.title ?? "",
  channelName: v.author ?? v.uploader ?? v.channelName ?? null,
  channelId: v.authorId ?? v.uploaderId ?? v.channelId ?? null,
  durationSeconds: v.lengthSeconds ?? v.duration ?? null,
  viewCount: Number(v.viewCount ?? v.views ?? 0),
  publishedText: v.publishedText ?? v.uploadedDate ?? null,
  thumbnails: (v.videoThumbnails ?? v.thumbnails ?? []).map((t) => t.url).slice(0, 3),
});

const normalizeChannel = (c) => ({
  id: c.authorId ?? c.id ?? c.ucid ?? null,
  title: c.author ?? c.name ?? c.title ?? "",
  avatar: (c.authorThumbnails ?? c.thumbnails ?? [])[0]?.url ?? null,
});

/* ====================== YT HTML SCRAPER (fallback) =================== */

function extractJSONFromHTML(html) {
  // Try multiple patterns seen on YouTube
  const patterns = [
    /var ytInitialData = (.*?);<\/script>/s,
    /"ytInitialData":(\{.*?\})\s*,\s*"ytcfg"/s,
    /window\["ytInitialData"\]\s*=\s*(.*?);<\/script>/s
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) {
      try { return JSON.parse(m[1]); } catch {}
    }
  }
  return null;
}

function collectRenderers(root, key) {
  const out = [];
  (function walk(n) {
    if (!n) return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (typeof n === "object") {
      if (n[key]) out.push(n[key]);
      for (const k in n) walk(n[k]);
    }
  })(root);
  return out;
}

function scrapeVideosFromInitialData(data) {
  const vrs = collectRenderers(data, "videoRenderer");
  return vrs.map(v => ({
    kind: "video",
    data: {
      id: v.videoId,
      title: (v.title?.runs?.[0]?.text) || "",
      channelName: (v.ownerText?.runs?.[0]?.text) || (v.longBylineText?.runs?.[0]?.text) || null,
      channelId: (v.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId)
                 || (v.longBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId)
                 || null,
      durationSeconds: null,
      viewCount: null,
      publishedText: v.publishedTimeText?.simpleText || null,
      thumbnails: (v.thumbnail?.thumbnails || []).map(t => t.url).slice(0,3)
    }
  }));
}

function scrapeChannelsFromInitialData(data) {
  const crs = collectRenderers(data, "channelRenderer");
  return crs.map(c => ({
    kind: "channel",
    data: {
      id: c.channelId || c.navigationEndpoint?.browseEndpoint?.browseId || null,
      title: c.title?.simpleText || c.title?.runs?.[0]?.text || "",
      avatar: (c.thumbnail?.thumbnails || [])[0]?.url || null
    }
  }));
}

async function ytHtmlFallbackSearch(q) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&hl=${SUGGEST_HL}&gl=${SUGGEST_GL}`;
  const html = await fetchText(url, 4500, { accept: "text/html" });
  const data = extractJSONFromHTML(html);
  if (!data) return { items: [], nextPage: 2, error: "yt_html_parse_failed" };

  const items = [
    ...scrapeVideosFromInitialData(data),
    ...scrapeChannelsFromInitialData(data)
  ];
  return { items, nextPage: 2 };
}

/* =========================== ROUTES ========================= */

/** SUGGEST: Invidious -> Piped -> Google suggest -> empty (never 5xx) */
app.get("/suggest", async (req, res) => {
  const q = String(req.query.q || "").trim();
  const key = req.originalUrl;
  const hit = respCache.get(key);
  if (hit) return res.status(hit.status).type("application/json").send(hit.body);
  if (!q) return sendJson(res, key, { suggestions: [] });

  try {
    // Build candidate URLs
    const invUrls  = INVIDIOUS_POOL.map(base => `${base}/api/v1/search/suggestions?q=${encodeURIComponent(q)}`);
    const pipUrls1 = PIPED_POOL.map(base => `${base}/suggestions?query=${encodeURIComponent(q)}`);
    const pipUrls2 = PIPED_POOL.map(base => `${base}/api/v1/suggestions?q=${encodeURIComponent(q)}`);

    // Race Invidious, then Piped, then Google
    const tryInv = () => firstResolved(invUrls.map(u => getCached("UPSTREAM:"+u, () => fetchJson(u))));
    const tryPip = () => firstResolved([...pipUrls1, ...pipUrls2].map(u => getCached("UPSTREAM:"+u, () => fetchJson(u))));

    let list;
    try {
      const raw = await tryInv();
      list = Array.isArray(raw) ? raw : (raw?.suggestions ?? []);
    } catch {
      try {
        const raw = await tryPip();
        list = Array.isArray(raw) ? raw : (raw?.suggestions ?? []);
      } catch {
        // Google’s suggest (YouTube dataset)
        const gUrl = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=${encodeURIComponent(SUGGEST_HL)}&gl=${encodeURIComponent(SUGGEST_GL)}&q=${encodeURIComponent(q)}`;
        const raw = await getCached("UPSTREAM:"+gUrl, () => fetchJson(gUrl, 2500));
        list = Array.isArray(raw) && Array.isArray(raw[1]) ? raw[1] : [];
      }
    }
    return sendJson(res, key, { suggestions: list.map(String).slice(0, 10) });
  } catch (_) {
    return sendJson(res, key, { suggestions: [], error: "upstream_unavailable" }, 200);
  }
});

/** CHANNELS */
app.get("/channels", async (req, res) => {
  const q = String(req.query.q || "").trim();
  const page = Number(req.query.page || 1);
  const key = req.originalUrl;
  const hit = respCache.get(key);
  if (hit) return res.status(hit.status).type("application/json").send(hit.body);
  if (!q) return sendJson(res, key, { items: [], nextPage: null });

  try {
    const invUrls = INVIDIOUS_POOL.map(base =>
      `${base}/api/v1/search?q=${encodeURIComponent("type:channel " + q)}&page=${page}`
    );
    const pipUrls = [
      ...PIPED_POOL.map(base => `${base}/search?query=${encodeURIComponent(q)}&filter=channels&page=${page}`),
      ...PIPED_POOL.map(base => `${base}/api/v1/search?q=${encodeURIComponent(q)}&filter=channels&page=${page}`)
    ];

    let list;
    try {
      const raw = await firstResolved(invUrls.map(u => getCached("UPSTREAM:"+u, () => fetchJson(u))));
      list = Array.isArray(raw) ? raw : (raw?.items ?? []);
      const items = list
        .filter((x) => (x.type ?? "").includes("channel") || x.authorId || x.channelId)
        .map((x) => ({ kind: "channel", data: normalizeChannel(x) }));
      return sendJson(res, key, { items, nextPage: page + 1 });
    } catch {
      try {
        const raw = await firstResolved(pipUrls.map(u => getCached("UPSTREAM:"+u, () => fetchJson(u))));
        const list2 = Array.isArray(raw) ? raw : (raw?.items ?? []);
        const items = list2
          .filter((x) => x.type === "channel" || x.authorId || x.channelId)
          .map((x) => ({ kind: "channel", data: normalizeChannel(x) }));
        return sendJson(res, key, { items, nextPage: page + 1 });
      } catch {
        // HTML fallback: pull channels from YT page too
        const fb = await ytHtmlFallbackSearch(q);
        const items = fb.items.filter(it => it.kind === "channel");
        return sendJson(res, key, { items, nextPage: page + 1, error: "upstream_unavailable" }, 200);
      }
    }
  } catch (_) {
    return sendJson(res, key, { items: [], nextPage: page + 1, error: "upstream_unavailable" }, 200);
  }
});

/** SEARCH (videos + channels + playlists) */
app.get("/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  const page = Number(req.query.page || 1);
  const key = req.originalUrl;
  const hit = respCache.get(key);
  if (hit) return res.status(hit.status).type("application/json").send(hit.body);
  if (!q) return sendJson(res, key, { items: [], nextPage: null });

  try {
    const invUrls = INVIDIOUS_POOL.map(base =>
      `${base}/api/v1/search?q=${encodeURIComponent(q)}&page=${page}`
    );
    const pipUrls = [
      ...PIPED_POOL.map(base => `${base}/search?query=${encodeURIComponent(q)}&page=${page}`),
      ...PIPED_POOL.map(base => `${base}/api/v1/search?q=${encodeURIComponent(q)}&page=${page}`)
    ];

    // Try Invidious (race), then Piped (race)
    try {
      const raw = await firstResolved(invUrls.map(u => getCached("UPSTREAM:"+u, () => fetchJson(u))));
      const items = (Array.isArray(raw) ? raw : (raw?.items ?? []))
        .map((it) => {
          if (it.type === "video" || it.videoId) return { kind: "video", data: normalizeVideo(it) };
          if (it.type === "channel" || it.authorId || it.channelId) return { kind: "channel", data: normalizeChannel(it) };
          if (it.type === "playlist" || it.playlistId) return { kind: "playlist", data: { id: it.playlistId, title: it.title ?? "" } };
          return null;
        })
        .filter(Boolean);
      return sendJson(res, key, { items, nextPage: page + 1 });
    } catch {
      try {
        const raw = await firstResolved(pipUrls.map(u => getCached("UPSTREAM:"+u, () => fetchJson(u))));
        const arr = Array.isArray(raw) ? raw : (raw?.items ?? []);
        const items = arr
          .map((it) => {
            if (it.type === "video") return { kind: "video", data: normalizeVideo(it) };
            if (it.type === "channel") return { kind: "channel", data: normalizeChannel(it) };
            if (it.type === "playlist") return { kind: "playlist", data: { id: it.playlistId ?? it.id, title: it.title ?? "" } };
            return null;
          })
          .filter(Boolean);
        return sendJson(res, key, { items, nextPage: page + 1 });
      } catch {
        // Final fallback: HTML scrape (page 1 only)
        if (page > 1) {
          return sendJson(res, key, { items: [], nextPage: page + 1, error: "upstream_unavailable" }, 200);
        }
        const fb = await ytHtmlFallbackSearch(q);
        return sendJson(res, key, fb, 200);
      }
    }
  } catch (_) {
    return sendJson(res, key, { items: [], nextPage: page + 1, error: "upstream_unavailable" }, 200);
  }
});

/* ------------ tiny debug helper to see which pools are used --------- */
app.get("/debug/upstreams", (_, res) => {
  res.json({ INVIDIOUS_POOL, PIPED_POOL, SUGGEST_HL, SUGGEST_GL, CACHE_TTL_S, CACHE_MAX, UPSTREAM_TIMEOUT_MS });
});

app.listen(PORT, () => {
  console.log(`search proxy listening on :${PORT}`);
});
