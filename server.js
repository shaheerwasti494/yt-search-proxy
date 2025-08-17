/* eslint-disable no-console */
"use strict";

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { LRUCache } = require("lru-cache");

const app = express();

/* ========================== CONFIG ========================== */

const PORT = process.env.PORT || 3000;

// Default single upstreams (you can add more via *_POOL envs)
const INVIDIOUS_BASE = process.env.INVIDIOUS_BASE || "https://yewtu.be";
const PIPED_BASE     = process.env.PIPED_BASE     || "https://pipedapi.kavin.rocks";

// Comma-separated pools (optional). Example:
// INVIDIOUS_POOL="https://yewtu.be,https://invidious.fdn.fr"
// PIPED_POOL="https://pipedapi.kavin.rocks,https://watchapi.whatever"
const parsePool = (envVar, fallback) =>
  (process.env[envVar]?.split(",").map(s => s.trim()).filter(Boolean) || fallback);

const INVIDIOUS_POOL = parsePool("INVIDIOUS_POOL", [INVIDIOUS_BASE]);
const PIPED_POOL     = parsePool("PIPED_POOL",     [PIPED_BASE]);

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

async function fetchJson(url, timeoutMs = UPSTREAM_TIMEOUT_MS, headers = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "yt-search-proxy/1.0", ...headers },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function getCachedJson(url, timeoutMs, headers) {
  const key = "UPSTREAM:" + url;
  if (respCache.has(key)) return respCache.get(key).json;
  const json = await fetchJson(url, timeoutMs, headers);
  respCache.set(key, { json }, { ttl: CACHE_TTL_S * 1000 });
  return json;
}

async function firstOk(urls, timeoutMs, headers) {
  let lastErr;
  for (const u of urls) {
    try {
      return await getCachedJson(u, timeoutMs, headers);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("no upstream");
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

/* =========================== ROUTES ========================= */

/** SUGGEST: Invidious -> Piped -> Google suggest -> empty (never 5xx) */
app.get("/suggest", async (req, res) => {
  const q = String(req.query.q || "").trim();
  const key = req.originalUrl;
  const hit = respCache.get(key);
  if (hit) return res.status(hit.status).type("application/json").send(hit.body);
  if (!q) return sendJson(res, key, { suggestions: [] });

  try {
    // 1) Invidious
    try {
      const invUrls = INVIDIOUS_POOL.map(
        base => `${base}/api/v1/search/suggestions?q=${encodeURIComponent(q)}`
      );
      const raw = await firstOk(invUrls, UPSTREAM_TIMEOUT_MS);
      const list = Array.isArray(raw) ? raw : (raw?.suggestions ?? []);
      if (Array.isArray(list) && list.length) {
        return sendJson(res, key, { suggestions: list.map(String).slice(0, 10) });
      }
      // fallthrough if empty
    } catch (_) {}

    // 2) Piped
    try {
      const pipUrls = PIPED_POOL.map(
        base => `${base}/suggestions?query=${encodeURIComponent(q)}`
      );
      const raw = await firstOk(pipUrls, UPSTREAM_TIMEOUT_MS);
      const list = Array.isArray(raw) ? raw : (raw?.suggestions ?? []);
      if (Array.isArray(list) && list.length) {
        return sendJson(res, key, { suggestions: list.map(String).slice(0, 10) });
      }
      // fallthrough if empty
    } catch (_) {}

    // 3) Google’s official suggestion endpoint (YouTube dataset)
    // Returns: ["q", ["s1","s2",...], ...]
    try {
      const gUrl = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=${encodeURIComponent(
        SUGGEST_HL
      )}&gl=${encodeURIComponent(SUGGEST_GL)}&q=${encodeURIComponent(q)}`;

      const raw = await getCachedJson(gUrl, 2500, { accept: "application/json" });
      const list = Array.isArray(raw) && Array.isArray(raw[1]) ? raw[1] : [];
      return sendJson(res, key, { suggestions: list.map(String).slice(0, 10) });
    } catch (_) {}

    // 4) Soft-fail: never 5xx
    return sendJson(res, key, { suggestions: [], error: "upstream_unavailable" }, 200);
  } catch (e) {
    return sendJson(res, key, { suggestions: [], error: "unexpected" }, 200);
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
    try {
      const invUrls = INVIDIOUS_POOL.map(
        base => `${base}/api/v1/search?q=${encodeURIComponent("type:channel " + q)}&page=${page}`
      );
      const raw = await firstOk(invUrls, UPSTREAM_TIMEOUT_MS);
      const items = (raw ?? [])
        .filter((x) => (x.type ?? "").includes("channel") || x.authorId)
        .map((x) => ({ kind: "channel", data: normalizeChannel(x) }));
      return sendJson(res, key, { items, nextPage: page + 1 });
    } catch (_) {
      const pipUrls = PIPED_POOL.map(
        base => `${base}/search?query=${encodeURIComponent(q)}&filter=channels&page=${page}`
      );
      const raw = await firstOk(pipUrls, UPSTREAM_TIMEOUT_MS);
      const list = Array.isArray(raw) ? raw : (raw?.items ?? []);
      const items = list
        .filter((x) => x.type === "channel" || x.authorId || x.channelId)
        .map((x) => ({ kind: "channel", data: normalizeChannel(x) }));
      return sendJson(res, key, { items, nextPage: page + 1 });
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
    try {
      const invUrls = INVIDIOUS_POOL.map(
        base => `${base}/api/v1/search?q=${encodeURIComponent(q)}&page=${page}`
      );
      const raw = await firstOk(invUrls, UPSTREAM_TIMEOUT_MS);
      const items = (raw ?? [])
        .map((it) => {
          if (it.type === "video" || it.videoId) return { kind: "video", data: normalizeVideo(it) };
          if (it.type === "channel" || it.authorId) return { kind: "channel", data: normalizeChannel(it) };
          if (it.type === "playlist" || it.playlistId) return { kind: "playlist", data: { id: it.playlistId, title: it.title } };
          return null;
        })
        .filter(Boolean);
      return sendJson(res, key, { items, nextPage: page + 1 });
    } catch (_) {
      const pipUrls = PIPED_POOL.map(
        base => `${base}/search?query=${encodeURIComponent(q)}&page=${page}`
      );
      const raw = await firstOk(pipUrls, UPSTREAM_TIMEOUT_MS);
      const arr = Array.isArray(raw) ? raw : (raw?.items ?? []);
      const items = arr
        .map((it) => {
          if (it.type === "video") return { kind: "video", data: normalizeVideo(it) };
          if (it.type === "channel") return { kind: "channel", data: normalizeChannel(it) };
          if (it.type === "playlist") return { kind: "playlist", data: { id: it.playlistId ?? it.id, title: it.title } };
          return null;
        })
        .filter(Boolean);
      return sendJson(res, key, { items, nextPage: page + 1 });
    }
  } catch (_) {
    return sendJson(res, key, { items: [], nextPage: page + 1, error: "upstream_unavailable" }, 200);
  }
});

app.listen(PORT, () => {
  console.log(`search proxy listening on :${PORT}`);
});
