"use strict";

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { LRUCache } = require("lru-cache");

const app = express();

// --- Config ---
const PORT = process.env.PORT || 3000;
const INV = process.env.INVIDIOUS_BASE || "https://yewtu.be";
const PIP = process.env.PIPED_BASE || "https://pipedapi.kavin.rocks";

// Add more public instances if you like
const INVIDIOUS_POOL = [INV];
const PIPED_POOL = [PIP];

const CACHE_TTL_S = Number(process.env.CACHE_TTL_S || 600);
const CACHE_MAX   = Number(process.env.CACHE_MAX || 2000);

// --- Middlewares ---
app.set("trust proxy", 1);
app.use(cors());
app.use(rateLimit({ windowMs: 60_000, max: 120 }));
app.get("/healthz", (_, res) => res.json({ ok: true }));

// --- Cache ---
const cache = new LRUCache({ max: CACHE_MAX, ttl: CACHE_TTL_S * 1000 });

function sendJson(res, key, payload, status = 200) {
  const body = JSON.stringify(payload);
  cache.set(key, { status, body });
  res.status(status).type("application/json").send(body);
}

async function getCachedJson(url, upstreamKey, timeoutMs = 3500) {
  if (cache.has(upstreamKey)) return cache.get(upstreamKey).json;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { accept: "application/json" }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const json = await r.json();
    cache.set(upstreamKey, { json }, { ttl: CACHE_TTL_S * 1000 });
    return json;
  } finally {
    clearTimeout(t);
  }
}

async function firstOk(urls) {
  let lastErr;
  for (const u of urls) {
    try {
      const json = await getCachedJson(u, "UPSTREAM:" + u);
      return json;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("no upstream");
}

// ----------------- ROUTES -----------------

app.get("/suggest", async (req, res) => {
  const q = String(req.query.q || "").trim();
  const key = req.originalUrl;
  const hit = cache.get(key);
  if (hit) return res.status(hit.status).type("application/json").send(hit.body);

  if (!q) return sendJson(res, key, { suggestions: [] });

  try {
    // Try Invidious first, then Piped
    const invUrls = INVIDIOUS_POOL.map(base => `${base}/api/v1/search/suggestions?q=${encodeURIComponent(q)}`);
    const pipUrls = PIPED_POOL.map(base => `${base}/suggestions?query=${encodeURIComponent(q)}`);

    let list;
    try {
      const raw = await firstOk(invUrls);
      list = Array.isArray(raw) ? raw : raw.suggestions ?? [];
    } catch {
      const raw = await firstOk(pipUrls);
      list = Array.isArray(raw) ? raw : raw.suggestions ?? [];
    }

    return sendJson(res, key, { suggestions: list.map(String).slice(0, 10) });
  } catch (e) {
    // IMPORTANT: never 5xx for suggest; just return empty suggestions
    return sendJson(res, key, { suggestions: [], error: "upstream_unavailable" }, 200);
  }
});

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

app.get("/channels", async (req, res) => {
  const q = String(req.query.q || "").trim();
  const page = Number(req.query.page || 1);
  const key = req.originalUrl;
  const hit = cache.get(key);
  if (hit) return res.status(hit.status).type("application/json").send(hit.body);

  if (!q) return sendJson(res, key, { items: [], nextPage: null });

  try {
    const invUrls = INVIDIOUS_POOL.map(base => `${base}/api/v1/search?q=${encodeURIComponent("type:channel " + q)}&page=${page}`);
    const pipUrls = PIPED_POOL.map(base => `${base}/search?query=${encodeURIComponent(q)}&filter=channels&page=${page}`);

    let items;
    try {
      const raw = await firstOk(invUrls);
      items = (raw ?? [])
        .filter((x) => (x.type ?? "").includes("channel") || x.authorId)
        .map((x) => ({ kind: "channel", data: normalizeChannel(x) }));
    } catch {
      const raw = await firstOk(pipUrls);
      const list = Array.isArray(raw) ? raw : raw.items ?? [];
      items = list
        .filter((x) => x.type === "channel" || x.authorId || x.channelId)
        .map((x) => ({ kind: "channel", data: normalizeChannel(x) }));
    }

    return sendJson(res, key, { items, nextPage: page + 1 });
  } catch (e) {
    // Channels can 502, but better to return empty than break UI
    return sendJson(res, key, { items: [], nextPage: page + 1, error: "upstream_unavailable" }, 200);
  }
});

app.get("/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  const page = Number(req.query.page || 1);
  const key = req.originalUrl;
  const hit = cache.get(key);
  if (hit) return res.status(hit.status).type("application/json").send(hit.body);

  if (!q) return sendJson(res, key, { items: [], nextPage: null });

  try {
    const invUrls = INVIDIOUS_POOL.map(base => `${base}/api/v1/search?q=${encodeURIComponent(q)}&page=${page}`);
    const pipUrls = PIPED_POOL.map(base => `${base}/search?query=${encodeURIComponent(q)}&page=${page}`);

    let items;
    try {
      const raw = await firstOk(invUrls);
      items = (raw ?? []).map((it) => {
        if (it.type === "video" || it.videoId) return { kind: "video", data: normalizeVideo(it) };
        if (it.type === "channel" || it.authorId) return { kind: "channel", data: normalizeChannel(it) };
        if (it.type === "playlist" || it.playlistId) return { kind: "playlist", data: { id: it.playlistId, title: it.title } };
        return null;
      }).filter(Boolean);
    } catch {
      const raw = await firstOk(pipUrls);
      const arr = Array.isArray(raw) ? raw : raw.items ?? [];
      items = arr.map((it) => {
        if (it.type === "video") return { kind: "video", data: normalizeVideo(it) };
        if (it.type === "channel") return { kind: "channel", data: normalizeChannel(it) };
        if (it.type === "playlist") return { kind: "playlist", data: { id: it.playlistId ?? it.id, title: it.title } };
        return null;
      }).filter(Boolean);
    }

    return sendJson(res, key, { items, nextPage: page + 1 });
  } catch (e) {
    // Keep /search resilient too
    return sendJson(res, key, { items: [], nextPage: page + 1, error: "upstream_unavailable" }, 200);
  }
});

app.listen(PORT, () => {
  console.log(`search proxy listening on :${PORT}`);
});
