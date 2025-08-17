/* A small Express proxy that exposes:
   GET /search?q=&page=
   GET /channels?q=&page=
   GET /suggest?q=
   GET /healthz
   Works on Railway (uses PORT env).
*/
"use strict";

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { LRUCache } = require("lru-cache"); // <-- v10+

const app = express();

const PORT = process.env.PORT || 3000;
const INVIDIOUS_BASE = process.env.INVIDIOUS_BASE || "https://yewtu.be";
const PIPED_BASE     = process.env.PIPED_BASE     || "https://pipedapi.kavin.rocks";
const CACHE_TTL_S    = Number(process.env.CACHE_TTL_S || 600);
const CACHE_MAX      = Number(process.env.CACHE_MAX || 2000);

app.set("trust proxy", 1);
app.use(cors());
app.use(rateLimit({ windowMs: 60_000, max: 120 }));

const respCache = new LRUCache({ max: CACHE_MAX, ttl: CACHE_TTL_S * 1000 });

// Utility to respond JSON + cache
function sendJson(res, key, payload, status = 200) {
  const body = JSON.stringify(payload);
  respCache.set(key, { status, body });
  res.status(status).type("application/json").send(body);
}

async function getCachedJson(url, upstreamKey) {
  // upstream cache (raw JSON from provider)
  if (respCache.has(upstreamKey)) return respCache.get(upstreamKey).json;
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  const json = await r.json();
  respCache.set(upstreamKey, { json }, { ttl: CACHE_TTL_S * 1000 });
  return json;
}

// --- Normalizers ---
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

// --- Routes ---
app.get("/suggest", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const cacheKey = req.originalUrl;
    const hit = respCache.get(cacheKey);
    if (hit) return res.status(hit.status).type("application/json").send(hit.body);

    if (!q) return sendJson(res, cacheKey, { suggestions: [] });

    // Try Invidious first
    try {
      const u = `${INVIDIOUS_BASE}/api/v1/search/suggestions?q=${encodeURIComponent(q)}`;
      const raw = await getCachedJson(u, "UPSTREAM:" + u);
      const list = Array.isArray(raw) ? raw : raw.suggestions ?? [];
      return sendJson(res, cacheKey, { suggestions: list.map(String) });
    } catch {
      // Fallback: Piped
      const u = `${PIPED_BASE}/suggestions?query=${encodeURIComponent(q)}`;
      const raw = await getCachedJson(u, "UPSTREAM:" + u);
      return sendJson(res, cacheKey, { suggestions: (raw ?? []).map(String) });
    }
  } catch (e) {
    return sendJson(res, req.originalUrl, { suggestions: [], error: String(e) }, 502);
  }
});

app.get("/channels", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const page = Number(req.query.page || 1);
    const cacheKey = req.originalUrl;
    const hit = respCache.get(cacheKey);
    if (hit) return res.status(hit.status).type("application/json").send(hit.body);

    if (!q) return sendJson(res, cacheKey, { items: [], nextPage: null });

    try {
      // Invidious with filter
      const u = `${INVIDIOUS_BASE}/api/v1/search?q=${encodeURIComponent("type:channel " + q)}&page=${page}`;
      const raw = await getCachedJson(u, "UPSTREAM:" + u);
      const items = (raw ?? [])
        .filter((x) => (x.type ?? "").includes("channel") || x.authorId)
        .map((x) => ({ kind: "channel", data: normalizeChannel(x) }));
      return sendJson(res, cacheKey, { items, nextPage: page + 1 });
    } catch {
      // Piped fallback
      const u = `${PIPED_BASE}/search?query=${encodeURIComponent(q)}&filter=channels&page=${page}`;
      const raw = await getCachedJson(u, "UPSTREAM:" + u);
      const list = Array.isArray(raw) ? raw : raw.items ?? [];
      const items = list
        .filter((x) => x.type === "channel" || x.authorId || x.channelId)
        .map((x) => ({ kind: "channel", data: normalizeChannel(x) }));
      return sendJson(res, cacheKey, { items, nextPage: page + 1 });
    }
  } catch (e) {
    return sendJson(res, req.originalUrl, { items: [], nextPage: null, error: String(e) }, 502);
  }
});

app.get("/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const page = Number(req.query.page || 1);
    const cacheKey = req.originalUrl;
    const hit = respCache.get(cacheKey);
    if (hit) return res.status(hit.status).type("application/json").send(hit.body);

    if (!q) return sendJson(res, cacheKey, { items: [], nextPage: null });

    // Invidious first
    try {
      const u = `${INVIDIOUS_BASE}/api/v1/search?q=${encodeURIComponent(q)}&page=${page}`;
      const raw = await getCachedJson(u, "UPSTREAM:" + u);
      const items = (raw ?? [])
        .map((it) => {
          if (it.type === "video" || it.videoId) return { kind: "video", data: normalizeVideo(it) };
          if (it.type === "channel" || it.authorId) return { kind: "channel", data: normalizeChannel(it) };
          if (it.type === "playlist" || it.playlistId)
            return { kind: "playlist", data: { id: it.playlistId, title: it.title } };
          return null;
        })
        .filter(Boolean);
      return sendJson(res, cacheKey, { items, nextPage: page + 1 });
    } catch {
      // Piped fallback
      const u = `${PIPED_BASE}/search?query=${encodeURIComponent(q)}&page=${page}`;
      const raw = await getCachedJson(u, "UPSTREAM:" + u);
      const arr = Array.isArray(raw) ? raw : raw.items ?? [];
      const items = arr
        .map((it) => {
          if (it.type === "video") return { kind: "video", data: normalizeVideo(it) };
          if (it.type === "channel") return { kind: "channel", data: normalizeChannel(it) };
          if (it.type === "playlist")
            return { kind: "playlist", data: { id: it.playlistId ?? it.id, title: it.title } };
          return null;
        })
        .filter(Boolean);
      return sendJson(res, cacheKey, { items, nextPage: page + 1 });
    }
  } catch (e) {
    return sendJson(res, req.originalUrl, { items: [], nextPage: null, error: String(e) }, 502);
  }
});

app.listen(PORT, () => {
  console.log(`search proxy listening on :${PORT}`);
});
