// Naya News Autopilot - Cloudflare Worker control plane.
// Serves the control panel, schedules pipeline runs on GitHub Actions, proxies Workers AI,
// hosts rendered images (KV, auto-expiring) and publishes posts through the Buffer API.
import DASHBOARD_HTML from "./dashboard.html";
import LOGIN_HTML from "./login.html";

const DEFAULTS = {
  enabled: false,
  interval_minutes: 120,
  posts_per_run: 1,
  daily_cap: 8,
  active_start_hour: 8,
  active_end_hour: 23,
  tz_offset_minutes: 300,
  approval_mode: false,
  max_article_age_hours: 24,
  brand_name: "Naya News",
  niche:
    "Pakistan-focused news: business, economy, technology, startups, government policy and important public-interest stories, plus major global tech and business news",
  tone: "neutral, factual, crisp and engaging, written by a human editor",
  language: "English",
  hashtag_count: 9,
  fixed_hashtags: ["#NayaNews"],
  disclaimer:
    "Disclaimer: This content is for informational purposes only. Image is AI generated and just for reference.",
  source_credit: "none",
  image_model: "@cf/black-forest-labs/flux-2-klein-4b",
  image_style:
    "bright high-end editorial photography, shot on a full-frame camera with a 35mm lens, sunny or brightly lit, vivid natural colours, high clarity",
  image_ai_label: false,
  people_in_images: "none",
  image_enhance: "normal",
  accent_color: "#FFC72C",
  footer_icons: ["facebook", "instagram", "x", "linkedin", "web"],
  footer_handle: "",
  image_retention_days: 14,
  text_models: ["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
  buffer_channels: [],
  last_dispatch_at: null,
  last_cleanup_date: null,
  asset_logo: false,
  asset_frame: false,
  custom_refs: [],
};
const INTERNAL_KEYS = new Set(["buffer_channels", "last_dispatch_at", "last_cleanup_date", "asset_logo", "asset_frame", "custom_refs"]);
const TEXT_FALLBACK_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const SESSION_COOKIE = "nn_session";
const SESSION_DAYS = 30;

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      return json({ error: err.message || String(err) }, err.status || 500);
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(tick(env));
  },
};

// ---------- helpers ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "referrer-policy": "same-origin",
    },
  });
}

const nowIso = () => new Date().toISOString();
const randomId = (bytes = 6) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

async function body(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  if (x.length !== y.length) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const sessionSecret = (env) => `${env.PIPELINE_SECRET}|${env.DASHBOARD_PASSWORD}`;

async function makeSession(env) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  return `${exp}.${await hmac(sessionSecret(env), `session:${exp}`)}`;
}

async function hasSession(request, env) {
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|; )${SESSION_COOKIE}=([^;]+)`));
  if (!match) return false;
  const [exp, sig] = match[1].split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await hmac(sessionSecret(env), `session:${exp}`));
}

function requirePipeline(request, env) {
  const auth = request.headers.get("authorization") || "";
  if (!env.PIPELINE_SECRET || !safeEqual(auth, `Bearer ${env.PIPELINE_SECRET}`)) throw new HttpError(401, "unauthorized");
}

// ---------- settings ----------

async function getSettings(env) {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings").all();
  const s = { ...DEFAULTS };
  for (const row of results) {
    try {
      s[row.key] = JSON.parse(row.value);
    } catch {
      /* keep default */
    }
  }
  return s;
}

async function saveSettings(env, patch) {
  const stmts = Object.entries(patch).map(([k, v]) =>
    env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, JSON.stringify(v)),
  );
  if (stmts.length) await env.DB.batch(stmts);
}

function cleanSettingsPatch(patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in DEFAULTS) || INTERNAL_KEYS.has(k)) continue;
    const def = DEFAULTS[k];
    if (typeof def === "number") {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new HttpError(400, `${k} must be a number`);
      out[k] = n;
    } else if (typeof def === "boolean") out[k] = Boolean(v);
    else if (Array.isArray(def)) out[k] = Array.isArray(v) ? v.map(String).filter(Boolean) : String(v).split(/[\s,]+/).filter(Boolean);
    else out[k] = String(v ?? "");
  }
  if ("interval_minutes" in out && out.interval_minutes < 15) throw new HttpError(400, "interval must be at least 15 minutes");
  if ("posts_per_run" in out) out.posts_per_run = Math.max(1, Math.min(5, Math.round(out.posts_per_run)));
  if ("daily_cap" in out) out.daily_cap = Math.max(1, Math.min(48, Math.round(out.daily_cap)));
  for (const k of ["active_start_hour", "active_end_hour"]) if (k in out) out[k] = Math.max(0, Math.min(24, Math.round(out[k])));
  if ("accent_color" in out && !/^#[0-9a-fA-F]{6}$/.test(out.accent_color)) throw new HttpError(400, "accent colour must look like #FFC72C");
  if ("source_credit" in out && !["none", "name", "link"].includes(out.source_credit)) throw new HttpError(400, "bad source_credit");
  if ("image_enhance" in out && !["off", "normal", "strong"].includes(out.image_enhance)) throw new HttpError(400, "bad image_enhance");
  if ("people_in_images" in out && !["none", "anonymous"].includes(out.people_in_images)) throw new HttpError(400, "bad people_in_images");
  return out;
}

// ---------- time helpers ----------

function localDate(s, ms = Date.now()) {
  return new Date(ms + s.tz_offset_minutes * 60000);
}

function inActiveHours(s, ms = Date.now()) {
  const h = localDate(s, ms).getUTCHours();
  const a = s.active_start_hour;
  const b = s.active_end_hour;
  if (a === b) return true;
  return a < b ? h >= a && h < b : h >= a || h < b;
}

function localDayStartIso(s, ms = Date.now()) {
  const d = localDate(s, ms);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - s.tz_offset_minutes * 60000;
  return new Date(start).toISOString();
}

async function publishedToday(env, s) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE status IN ('published','partial') AND published_at >= ?")
    .bind(localDayStartIso(s))
    .first();
  return row?.n || 0;
}

function nextRunEstimate(s) {
  if (!s.enabled) return null;
  let t = Math.max(Date.now(), (s.last_dispatch_at ? Date.parse(s.last_dispatch_at) : 0) + s.interval_minutes * 60000);
  for (let i = 0; i < 96 && !inActiveHours(s, t); i++) t += 15 * 60000;
  return new Date(t).toISOString();
}

// ---------- GitHub dispatch ----------

async function dispatch(env, mode, trigger, articleUrl = "") {
  if (!env.GH_TOKEN || !env.GH_REPO) throw new HttpError(500, "GitHub is not configured on the Worker");
  const runId = randomId();
  await env.DB.prepare("INSERT INTO runs (id, started_at, mode, trigger, status, summary) VALUES (?, ?, ?, ?, 'dispatched', ?)")
    .bind(runId, nowIso(), mode, trigger, articleUrl ? `article: ${articleUrl}` : "")
    .run();
  const res = await fetch(`https://api.github.com/repos/${env.GH_REPO}/actions/workflows/${env.GH_WORKFLOW || "pipeline.yml"}/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GH_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "naya-news-autopilot",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ref: env.GH_REF || "main", inputs: { mode, run_id: runId, trigger, article_url: articleUrl } }),
  });
  if (res.status !== 204) {
    const text = (await res.text()).slice(0, 300);
    await env.DB.prepare("UPDATE runs SET status = 'error', finished_at = ?, summary = ? WHERE id = ?")
      .bind(nowIso(), `GitHub dispatch failed (${res.status}): ${text}`, runId)
      .run();
    throw new HttpError(502, `GitHub dispatch failed (${res.status}): ${text}`);
  }
  return runId;
}

// ---------- scheduler ----------

async function tick(env) {
  const s = await getSettings(env);
  const stale = new Date(Date.now() - 40 * 60000).toISOString();
  await env.DB.prepare("UPDATE runs SET status = 'timeout', finished_at = ? WHERE status IN ('dispatched','running') AND started_at < ?")
    .bind(nowIso(), stale)
    .run();
  await dailyCleanup(env, s);

  if (!s.enabled || !inActiveHours(s)) return;
  const last = s.last_dispatch_at ? Date.parse(s.last_dispatch_at) : 0;
  if (Date.now() - last < s.interval_minutes * 60000 - 90000) return;
  if ((await publishedToday(env, s)) >= s.daily_cap) return;
  const busy = await env.DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE status IN ('dispatched','running')").first();
  if (busy?.n) return;
  await saveSettings(env, { last_dispatch_at: nowIso() });
  try {
    await dispatch(env, "live", "schedule");
  } catch (err) {
    console.error("scheduled dispatch failed", err.message);
  }
}

async function dailyCleanup(env, s) {
  const today = localDate(s).toISOString().slice(0, 10);
  if (s.last_cleanup_date === today) return;
  const month = new Date(Date.now() - 30 * 86400000).toISOString();
  const quarter = new Date(Date.now() - 90 * 86400000).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM seen WHERE seen_at < ?").bind(month),
    env.DB.prepare("DELETE FROM runs WHERE started_at < ?").bind(month),
    env.DB.prepare("DELETE FROM posts WHERE created_at < ?").bind(quarter),
  ]);
  await saveSettings(env, { last_cleanup_date: today });
}

// ---------- Buffer ----------

async function buffer(env, query) {
  if (!env.BUFFER_API_KEY) throw new HttpError(500, "BUFFER_API_KEY is not set on the Worker");
  const res = await fetch("https://api.buffer.com", {
    method: "POST",
    headers: { authorization: `Bearer ${env.BUFFER_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.errors) {
    const msg = data.errors ? data.errors.map((e) => e.message).join("; ") : `HTTP ${res.status}`;
    throw new HttpError(502, `Buffer: ${msg}`);
  }
  return data.data;
}

const gqlString = (v) => JSON.stringify(String(v));

async function refreshChannels(env) {
  const s = await getSettings(env);
  const previous = new Map((s.buffer_channels || []).map((c) => [c.id, c]));
  const data = await buffer(env, "query { account { organizations { id name } } }");
  const channels = [];
  for (const org of data.account.organizations) {
    const res = await buffer(env, `query { channels(input: { organizationId: ${gqlString(org.id)} }) { id name displayName service avatar isQueuePaused } }`);
    for (const c of res.channels) {
      channels.push({
        id: c.id,
        name: c.displayName || c.name,
        service: c.service,
        avatar: c.avatar,
        organization: org.name,
        enabled: previous.has(c.id) ? previous.get(c.id).enabled : true,
      });
    }
  }
  await saveSettings(env, { buffer_channels: channels });
  return channels;
}

async function publishPost(env, origin, post, s) {
  const channels = (s.buffer_channels || []).filter((c) => c.enabled);
  if (!channels.length) {
    return { status: "failed", error: "No Buffer channel enabled. Connect LinkedIn in Buffer, then click Refresh channels in the panel.", results: [] };
  }
  const imageUrl = `${origin}/img/${post.id}.jpg`;
  const results = [];
  for (const ch of channels) {
    const q = `mutation { createPost(input: { text: ${gqlString(post.caption)}, channelId: ${gqlString(ch.id)}, schedulingType: automatic, mode: shareNow, assets: [{ image: { url: ${gqlString(imageUrl)} } }] }) { __typename ... on PostActionSuccess { post { id status dueAt } } ... on MutationError { message } } }`;
    try {
      const data = await buffer(env, q);
      const r = data.createPost;
      if (r.post) results.push({ channel: ch.name, service: ch.service, ok: true, buffer_post_id: r.post.id, buffer_status: r.post.status });
      else results.push({ channel: ch.name, service: ch.service, ok: false, error: r.message || r.__typename });
    } catch (err) {
      results.push({ channel: ch.name, service: ch.service, ok: false, error: err.message });
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  const status = okCount === results.length ? "published" : okCount ? "partial" : "failed";
  const error = results.filter((r) => !r.ok).map((r) => `${r.channel}: ${r.error}`).join("; ");
  return { status, error, results };
}

async function applyPublish(env, origin, post, s) {
  const out = await publishPost(env, origin, post, s);
  await env.DB.prepare("UPDATE posts SET status = ?, error = ?, channel_results = ?, published_at = ? WHERE id = ?")
    .bind(out.status, out.error || null, JSON.stringify(out.results), out.status === "failed" ? null : nowIso(), post.id)
    .run();
  return out;
}

// ---------- Workers AI ----------

async function aiImage(env, { prompt, width = 1024, height = 1232, model, references = [] }) {
  if (!prompt) throw new HttpError(400, "prompt required");
  const m = model || DEFAULTS.image_model;
  let res;
  if (m.includes("flux-2")) {
    const form = new FormData();
    form.append("prompt", prompt.slice(0, 2000));
    form.append("width", String(width));
    form.append("height", String(height));
    // Reference pictures (e.g. real flag images) keep small details accurate; max 4, each < 512px.
    references.slice(0, 4).forEach((b64, i) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      form.append(`input_image_${i}`, new Blob([bytes], { type: "image/png" }), `ref${i}.png`);
    });
    const packed = new Response(form);
    res = await env.AI.run(m, { multipart: { body: packed.body, contentType: packed.headers.get("content-type") } });
  } else {
    res = await env.AI.run(m, { prompt: prompt.slice(0, 2000), steps: 4 });
  }
  if (!res?.image) throw new HttpError(502, `${m} returned no image`);
  return { image: res.image, model: m };
}

async function aiText(env, { system, user }) {
  const res = await env.AI.run(TEXT_FALLBACK_MODEL, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: 1800,
    temperature: 0.5,
  });
  const text = typeof res.response === "string" ? res.response : JSON.stringify(res.response);
  return { text, model: TEXT_FALLBACK_MODEL };
}

// ---------- state for the panel ----------

function rowToPost(r, origin) {
  const parse = (v, d) => {
    try {
      return v ? JSON.parse(v) : d;
    } catch {
      return d;
    }
  };
  return {
    ...r,
    highlights: parse(r.highlights, []),
    hashtags: parse(r.hashtags, []),
    channel_results: parse(r.channel_results, []),
    image_url: r.image_key ? `${origin}/img/${r.id}.jpg` : null,
  };
}

async function panelState(env, origin) {
  const s = await getSettings(env);
  const [feeds, posts, runs, today, total] = await Promise.all([
    env.DB.prepare("SELECT * FROM feeds ORDER BY id").all(),
    env.DB.prepare("SELECT * FROM posts ORDER BY created_at DESC LIMIT 40").all(),
    env.DB.prepare("SELECT id, started_at, finished_at, mode, trigger, status, summary, gh_run_url FROM runs ORDER BY started_at DESC LIMIT 25").all(),
    publishedToday(env, s),
    env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE status IN ('published','partial')").first(),
  ]);
  return {
    settings: s,
    feeds: feeds.results,
    posts: posts.results.map((r) => rowToPost(r, origin)),
    runs: runs.results,
    stats: { published_today: today, published_total: total?.n || 0, next_run: nextRunEstimate(s), now: nowIso() },
    assets: { logo: s.asset_logo, frame: s.asset_frame },
    config: {
      buffer: Boolean(env.BUFFER_API_KEY),
      github: Boolean(env.GH_TOKEN && env.GH_REPO),
      repo: env.GH_REPO || "",
    },
  };
}

// ---------- router ----------

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;
  const origin = url.origin;

  // Public
  if (path === "/health") return json({ ok: true });
  let m = path.match(/^\/img\/([a-f0-9]{8,32})\.jpg$/);
  if (m && method === "GET") {
    const data = await env.IMAGES.get(`img:${m[1]}`, { type: "arrayBuffer", cacheTtl: 3600 });
    if (!data) return new Response("not found", { status: 404 });
    return new Response(data, { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=86400" } });
  }
  m = path.match(/^\/asset\/ref\/([A-Za-z0-9_]{2,40})$/);
  if (m && method === "GET") {
    const obj = await env.IMAGES.getWithMetadata(`ref:${m[1]}`, { type: "arrayBuffer" });
    if (!obj.value) return new Response("not found", { status: 404 });
    return new Response(obj.value, { headers: { "content-type": obj.metadata?.type || "image/png", "cache-control": "no-cache" } });
  }
  m = path.match(/^\/asset\/(logo|frame)\.png$/);
  if (m && method === "GET") {
    const data = await env.IMAGES.get(`asset:${m[1]}`, { type: "arrayBuffer" });
    if (!data) return new Response("not found", { status: 404 });
    return new Response(data, { headers: { "content-type": "image/png", "cache-control": "no-cache" } });
  }
  if (path === "/") return html((await hasSession(request, env)) ? DASHBOARD_HTML : LOGIN_HTML);
  if (path === "/api/login" && method === "POST") {
    const { password } = await body(request);
    if (!env.DASHBOARD_PASSWORD || !safeEqual(password || "", env.DASHBOARD_PASSWORD)) {
      await new Promise((r) => setTimeout(r, 1000));
      throw new HttpError(401, "Wrong password");
    }
    const cookie = `${SESSION_COOKIE}=${await makeSession(env)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`;
    return json({ ok: true }, 200, { "set-cookie": cookie });
  }
  if (path === "/api/logout" && method === "POST") {
    return json({ ok: true }, 200, { "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
  }

  // Pipeline (GitHub Actions)
  if (path.startsWith("/pipeline/")) {
    requirePipeline(request, env);
    return pipelineRoute(request, env, path, method, origin);
  }

  // Control panel API
  if (path.startsWith("/api/")) {
    if (!(await hasSession(request, env))) throw new HttpError(401, "Please log in again");
    return panelRoute(request, env, path, method, origin);
  }
  return new Response("not found", { status: 404 });
}

async function pipelineRoute(request, env, path, method, origin) {
  let m;
  if (path === "/pipeline/config" && method === "GET") {
    const s = await getSettings(env);
    const [feeds, seen, recent, today] = await Promise.all([
      env.DB.prepare("SELECT id, url, name, category, enabled FROM feeds WHERE enabled = 1").all(),
      env.DB.prepare("SELECT guid FROM seen").all(),
      env.DB.prepare("SELECT title_key FROM seen WHERE title_key IS NOT NULL ORDER BY seen_at DESC LIMIT 400").all(),
      publishedToday(env, s),
    ]);
    return json({
      settings: s,
      feeds: feeds.results,
      seen: seen.results.map((r) => r.guid),
      recent_title_keys: recent.results.map((r) => r.title_key),
      remaining_today: Math.max(0, s.daily_cap - today),
      assets: { logo: s.asset_logo, frame: s.asset_frame },
      custom_refs: s.custom_refs || [],
    });
  }
  if (path === "/pipeline/runs" && method === "POST") {
    const b = await body(request);
    const id = String(b.id || randomId()).slice(0, 32);
    await env.DB.prepare(
      `INSERT INTO runs (id, started_at, mode, trigger, status, gh_run_url) VALUES (?, ?, ?, ?, 'running', ?)
       ON CONFLICT(id) DO UPDATE SET status = 'running', gh_run_url = excluded.gh_run_url`,
    )
      .bind(id, nowIso(), b.mode || "test", b.trigger || "manual", b.gh_run_url || null)
      .run();
    return json({ id });
  }
  if ((m = path.match(/^\/pipeline\/runs\/([\w-]+)$/)) && method === "PATCH") {
    const b = await body(request);
    await env.DB.prepare("UPDATE runs SET status = ?, summary = ?, log = ?, finished_at = ? WHERE id = ?")
      .bind(b.status || "done", b.summary || "", b.log || "", nowIso(), m[1])
      .run();
    return json({ ok: true });
  }
  if (path === "/pipeline/ai/image" && method === "POST") return json(await aiImage(env, await body(request)));
  if (path === "/pipeline/ai/text" && method === "POST") return json(await aiText(env, await body(request)));
  if ((m = path.match(/^\/pipeline\/images\/([a-f0-9]{8,32})$/)) && method === "PUT") {
    const s = await getSettings(env);
    const data = await request.arrayBuffer();
    if (data.byteLength < 1000 || data.byteLength > 5_000_000) throw new HttpError(400, "image size out of range");
    await env.IMAGES.put(`img:${m[1]}`, data, { expirationTtl: Math.max(2, s.image_retention_days) * 86400 });
    return json({ url: `${origin}/img/${m[1]}.jpg` });
  }
  if (path === "/pipeline/posts" && method === "POST") {
    const p = await body(request);
    const s = await getSettings(env);
    const status = p.mode === "live" ? (s.approval_mode ? "draft" : "publishing") : "test";
    await env.DB.prepare(
      `INSERT INTO posts (id, created_at, status, source_url, source_name, source_title, headline, highlights, caption, hashtags,
        image_key, image_prompt, alt_text, category, image_model, text_model, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        p.id, nowIso(), status, p.source_url || null, p.source_name || null, p.source_title || null, p.headline || "",
        JSON.stringify(p.highlights || []), p.caption || "", JSON.stringify(p.hashtags || []), `img:${p.id}`,
        p.image_prompt || null, p.alt_text || null, p.category || null, p.image_model || null, p.text_model || null, p.run_id || null,
      )
      .run();
    if (status !== "publishing") return json({ id: p.id, status, image_url: `${origin}/img/${p.id}.jpg` });
    const out = await applyPublish(env, origin, p, s);
    return json({ id: p.id, status: out.status, error: out.error, image_url: `${origin}/img/${p.id}.jpg` });
  }
  if (path === "/pipeline/seen" && method === "POST") {
    const { items = [] } = await body(request);
    const stmts = items.slice(0, 50).map((it) =>
      env.DB.prepare("INSERT OR IGNORE INTO seen (guid, title_key, seen_at) VALUES (?, ?, ?)").bind(String(it.guid).slice(0, 500), it.title_key || null, nowIso()),
    );
    if (stmts.length) await env.DB.batch(stmts);
    return json({ ok: true });
  }
  if (path === "/pipeline/feed-status" && method === "POST") {
    const { results = [] } = await body(request);
    const stmts = results.slice(0, 100).map((r) =>
      env.DB.prepare("UPDATE feeds SET last_fetched_at = ?, last_error = ?, last_count = ? WHERE id = ?").bind(nowIso(), r.error || null, r.count || 0, r.id),
    );
    if (stmts.length) await env.DB.batch(stmts);
    return json({ ok: true });
  }
  throw new HttpError(404, "unknown pipeline route");
}

async function panelRoute(request, env, path, method, origin) {
  let m;
  if (path === "/api/state" && method === "GET") return json(await panelState(env, origin));
  if (path === "/api/settings" && method === "POST") {
    const patch = cleanSettingsPatch(await body(request));
    await saveSettings(env, patch);
    return json({ ok: true, saved: Object.keys(patch) });
  }
  if (path === "/api/toggle" && method === "POST") {
    const { enabled } = await body(request);
    const patch = { enabled: Boolean(enabled) };
    // Starting fresh: run soon instead of waiting a full interval.
    if (enabled) patch.last_dispatch_at = null;
    await saveSettings(env, patch);
    return json({ ok: true, enabled: Boolean(enabled) });
  }
  if (path === "/api/run" && method === "POST") {
    const b = await body(request);
    const mode = b.mode === "live" ? "live" : "test";
    const articleUrl = String(b.article_url || "").trim();
    if (articleUrl && !/^https?:\/\/\S+$/.test(articleUrl)) throw new HttpError(400, "article URL must start with http(s)://");
    const busy = await env.DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE status IN ('dispatched','running')").first();
    if (busy?.n) throw new HttpError(409, "A run is already in progress. Wait for it to finish.");
    return json({ ok: true, run_id: await dispatch(env, mode, "panel", articleUrl) });
  }
  if (path === "/api/channels/refresh" && method === "POST") return json({ channels: await refreshChannels(env) });
  if (path === "/api/channels" && method === "POST") {
    const { id, enabled } = await body(request);
    const s = await getSettings(env);
    const channels = (s.buffer_channels || []).map((c) => (c.id === id ? { ...c, enabled: Boolean(enabled) } : c));
    await saveSettings(env, { buffer_channels: channels });
    return json({ ok: true });
  }
  if (path === "/api/feeds" && method === "POST") {
    const b = await body(request);
    const url = String(b.url || "").trim();
    if (!/^https?:\/\/\S+$/.test(url)) throw new HttpError(400, "Feed URL must start with http(s)://");
    await env.DB.prepare("INSERT INTO feeds (url, name, category, enabled, created_at) VALUES (?, ?, ?, 1, ?)")
      .bind(url, String(b.name || "").trim() || null, String(b.category || "").trim() || null, nowIso())
      .run()
      .catch(() => {
        throw new HttpError(409, "That feed is already in the list");
      });
    return json({ ok: true });
  }
  if ((m = path.match(/^\/api\/feeds\/(\d+)$/))) {
    if (method === "DELETE") {
      await env.DB.prepare("DELETE FROM feeds WHERE id = ?").bind(Number(m[1])).run();
      return json({ ok: true });
    }
    if (method === "PATCH") {
      const b = await body(request);
      const fields = {};
      if ("enabled" in b) fields.enabled = b.enabled ? 1 : 0;
      if ("name" in b) fields.name = String(b.name || "") || null;
      if ("category" in b) fields.category = String(b.category || "") || null;
      const sets = Object.keys(fields).map((k) => `${k} = ?`);
      const vals = Object.values(fields);
      if (sets.length) await env.DB.prepare(`UPDATE feeds SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, Number(m[1])).run();
      return json({ ok: true });
    }
  }
  if ((m = path.match(/^\/api\/posts\/([a-f0-9]{8,32})(\/publish)?$/))) {
    const row = await env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(m[1]).first();
    if (!row) throw new HttpError(404, "post not found");
    if (m[2] && method === "POST") {
      if (row.status === "published") throw new HttpError(409, "Already published");
      if (!(await env.IMAGES.get(`img:${row.id}`, { type: "stream" }).then((v) => (v ? (v.cancel(), true) : false))))
        throw new HttpError(410, "Image has expired; run the pipeline again for this story");
      const out = await applyPublish(env, origin, row, await getSettings(env));
      return json(out);
    }
    if (method === "PATCH") {
      const b = await body(request);
      await env.DB.prepare("UPDATE posts SET caption = ? WHERE id = ?").bind(String(b.caption || ""), row.id).run();
      return json({ ok: true });
    }
    if (method === "DELETE") {
      await env.IMAGES.delete(`img:${row.id}`);
      await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(row.id).run();
      return json({ ok: true });
    }
  }
  if ((m = path.match(/^\/api\/refs\/([A-Za-z0-9_]{2,40})$/))) {
    const key = m[1].toUpperCase();
    const s = await getSettings(env);
    const list = (s.custom_refs || []).filter((r) => r.key !== key);
    if (method === "PUT") {
      const type = request.headers.get("content-type") || "";
      if (!/^image\/(png|jpeg)$/.test(type)) throw new HttpError(400, "Upload a PNG or JPG picture");
      const data = await request.arrayBuffer();
      if (data.byteLength > 4_000_000) throw new HttpError(400, "Picture must be under 4 MB");
      const url = new URL(request.url);
      const kind = ["flag", "emblem", "building"].includes(url.searchParams.get("kind")) ? url.searchParams.get("kind") : "flag";
      const name = (url.searchParams.get("name") || key).slice(0, 80);
      const desc = (url.searchParams.get("desc") || "").slice(0, 300);
      await env.IMAGES.put(`ref:${key}`, data, { metadata: { type } });
      list.push({ key, name, kind, desc });
      await saveSettings(env, { custom_refs: list });
      return json({ ok: true, key });
    }
    if (method === "DELETE") {
      await env.IMAGES.delete(`ref:${key}`);
      await saveSettings(env, { custom_refs: list });
      return json({ ok: true });
    }
  }
  if ((m = path.match(/^\/api\/assets\/(logo|frame)$/))) {
    if (method === "PUT") {
      const data = await request.arrayBuffer();
      const sig = new Uint8Array(data.slice(0, 8));
      if (sig[0] !== 0x89 || sig[1] !== 0x50) throw new HttpError(400, "Please upload a PNG file");
      if (data.byteLength > 4_000_000) throw new HttpError(400, "PNG must be under 4 MB");
      await env.IMAGES.put(`asset:${m[1]}`, data);
      await saveSettings(env, { [`asset_${m[1]}`]: true });
      return json({ ok: true });
    }
    if (method === "DELETE") {
      await env.IMAGES.delete(`asset:${m[1]}`);
      await saveSettings(env, { [`asset_${m[1]}`]: false });
      return json({ ok: true });
    }
  }
  throw new HttpError(404, "unknown route");
}
