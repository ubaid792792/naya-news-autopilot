// Naya News Autopilot - Cloudflare Worker control plane.
// Serves the control panel, schedules pipeline runs on GitHub Actions, proxies Workers AI,
// hosts rendered images (KV, auto-expiring) and publishes posts through the Buffer API.
import DASHBOARD_HTML from "./dashboard.html";
import LOGIN_HTML from "./login.html";
import * as social from "./social.js";
import * as images from "./images.js";
import * as usage from "./usage.js";

const DEFAULTS = {
  enabled: false,
  interval_minutes: 120,
  posts_per_run: 1,
  daily_cap: 8,
  active_start_hour: 8,
  active_end_hour: 23,
  day_start_hour: 0,
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
  image_model: "auto",
  image_style:
    "bright high-end editorial photography, shot on a full-frame camera with a 35mm lens, sunny or brightly lit, vivid natural colours, high clarity",
  image_ai_label: false,
  people_in_images: "none",
  stories_per_collection: 3,
  queue_max_items: 30,
  queue_max_age_hours: 24,
  queue_order: "freshest",
  queue_sheet_link: "",
  image_enhance: "normal",
  accent_color: "#FFC72C",
  footer_icons: ["facebook", "instagram", "x", "linkedin", "web"],
  footer_handle: "",
  image_retention_days: 14,
  text_models: [
    "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-flash-latest",
    "gemini-3-flash-preview", "gemini-2.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite",
    "gemini-flash-lite-latest", "gemini-2.5-flash-lite", "gemma-4-31b-it", "gemma-4-26b-a4b-it",
  ],
  buffer_channels: [],
  last_dispatch_at: null,
  last_cleanup_date: null,
  asset_logo: false,
  asset_frame: false,
  custom_refs: [],
  publish_linkedin: true,
  publish_instagram: true,
  li_token: null,
  li_expires: null,
  li_person: null,
  li_name: null,
  ig_token: null,
  ig_expires: null,
  ig_token_at: null,
  ig_user_id: null,
  ig_username: null,
  ig_app_secret: null,
  panel_password_hash: null,
};
const INTERNAL_KEYS = new Set(["buffer_channels", "last_dispatch_at", "last_cleanup_date", "asset_logo", "asset_frame", "custom_refs",
  "li_token", "li_expires", "li_person", "li_name", "ig_token", "ig_expires", "ig_token_at", "ig_user_id", "ig_username",
  "ig_app_secret", "panel_password_hash"]);
// Settings safe to show in the panel or send to the pipeline (no access tokens).
const publicSettings = (s) => Object.fromEntries(Object.entries(s).filter(([k]) => !social.SECRET_SETTING_KEYS.includes(k)));
const TEXT_MODELS = { large: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", small: "@cf/meta/llama-3.1-8b-instruct-fast" };
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

// The panel password can be changed in the panel; it is stored as a salted PBKDF2 hash. Until then
// the DASHBOARD_PASSWORD secret is used. Changing it signs out every other browser.
const PBKDF2_ROUNDS = 5000;
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function pbkdf2(password, saltHex, rounds) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const salt = Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: rounds }, key, 256));
}

async function hashPassword(password) {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  return `pbkdf2$${PBKDF2_ROUNDS}$${salt}$${await pbkdf2(password, salt, PBKDF2_ROUNDS)}`;
}

async function checkPassword(env, s, password) {
  if (s.panel_password_hash) {
    const [, rounds, salt, want] = s.panel_password_hash.split("$");
    return safeEqual(await pbkdf2(String(password || ""), salt, Number(rounds)), want);
  }
  return Boolean(env.DASHBOARD_PASSWORD) && safeEqual(password || "", env.DASHBOARD_PASSWORD);
}

const sessionSecret = (env, s) => `${env.PIPELINE_SECRET}|${s.panel_password_hash || env.DASHBOARD_PASSWORD}`;

async function makeSession(env, s) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  return `${exp}.${await hmac(sessionSecret(env, s), `session:${exp}`)}`;
}

const sessionCookie = (value) => `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`;

async function hasSession(request, env) {
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|; )${SESSION_COOKIE}=([^;]+)`));
  if (!match) return false;
  const [exp, sig] = match[1].split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await hmac(sessionSecret(env, await getSettings(env)), `session:${exp}`));
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
  if ("interval_minutes" in out && out.interval_minutes < 5) throw new HttpError(400, "interval must be at least 5 minutes");
  if ("posts_per_run" in out) out.posts_per_run = Math.max(1, Math.min(10, Math.round(out.posts_per_run)));
  if ("daily_cap" in out) out.daily_cap = Math.max(1, Math.min(1500, Math.round(out.daily_cap)));
  for (const k of ["active_start_hour", "active_end_hour", "day_start_hour"]) if (k in out) out[k] = Math.max(0, Math.min(24, Math.round(out[k])));
  if ("accent_color" in out && !/^#[0-9a-fA-F]{6}$/.test(out.accent_color)) throw new HttpError(400, "accent colour must look like #FFC72C");
  if ("source_credit" in out && !["none", "name", "link"].includes(out.source_credit)) throw new HttpError(400, "bad source_credit");
  if ("queue_order" in out && !["freshest", "top"].includes(out.queue_order)) throw new HttpError(400, "bad queue_order");
  if ("stories_per_collection" in out) out.stories_per_collection = Math.max(1, Math.min(10, Math.round(out.stories_per_collection)));
  if ("queue_max_items" in out) out.queue_max_items = Math.max(5, Math.min(200, Math.round(out.queue_max_items)));
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

// Start of the current posting day (local time), which begins at day_start_hour, e.g. 08:00.
function localDayStartIso(s, ms = Date.now()) {
  const shift = (Number(s.day_start_hour) || 0) * 3600000;
  const d = localDate(s, ms - shift);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - s.tz_offset_minutes * 60000 + shift;
  return new Date(start).toISOString();
}

async function publishedSince(env, iso) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE status IN ('published','partial') AND published_at >= ?")
    .bind(iso)
    .first();
  return row?.n || 0;
}

const publishedToday = (env, s) => publishedSince(env, localDayStartIso(s));

// Posts still allowed by the user's daily cap. Each destination's own limit (Buffer 50 per channel
// per day, Instagram 100 per day) is checked separately when posting.
async function remainingToday(env, s) {
  return Math.max(0, s.daily_cap - (await publishedToday(env, s)));
}

// Rough number of posts still to come before the free AI allowance resets (00:00 UTC).
async function postsLeftUtc(env, s) {
  const minutes = (Date.parse(`${usage.utcDay(Date.now() + 86400000)}T00:00:00Z`) - Date.now()) / 60000;
  const slots = Math.ceil(minutes / Math.max(5, s.interval_minutes)) * (s.posts_per_run || 1);
  return Math.max(1, Math.min(await remainingToday(env, s), slots));
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
  try {
    const renewed = await social.instagramRefresh(s);
    if (renewed) await saveSettings(env, renewed);
  } catch (err) {
    console.error(err.message);
  }
  // Final-status checks cost one Buffer API call per post; skip them at high volume so a month of
  // posting fits Buffer's free 3,000 calls per 30 days.
  if (s.daily_cap <= 40) await syncSendingPosts(env).catch((err) => console.error("status sync failed", err.message));

  if (!s.enabled || !inActiveHours(s)) return;
  const last = s.last_dispatch_at ? Date.parse(s.last_dispatch_at) : 0;
  if (Date.now() - last < s.interval_minutes * 60000 - 90000) return;
  if ((await remainingToday(env, s)) <= 0) return;
  if (!(await usage.capacity(env, s)).any) return;
  const busy = await env.DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE status IN ('dispatched','running')").first();
  if (busy?.n) return;
  await saveSettings(env, { last_dispatch_at: nowIso() });
  try {
    await dispatch(env, "live", "schedule");
  } catch (err) {
    console.error("scheduled dispatch failed", err.message);
  }
}

// Buffer accepts a post as "sending" and finishes a moment later; record the final result and the
// LinkedIn link, or turn the post into a failure the panel can show.
async function syncSendingPosts(env) {
  if (!env.BUFFER_API_KEY) return;
  const since = new Date(Date.now() - 3 * 3600000).toISOString();
  const { results } = await env.DB.prepare(
    "SELECT id, channel_results FROM posts WHERE status IN ('published','partial') AND published_at > ? AND channel_results LIKE '%\"buffer_status\":\"sending\"%'",
  ).bind(since).all();
  for (const post of results.slice(0, 5)) {
    const list = JSON.parse(post.channel_results || "[]");
    for (const r of list) {
      if (!r.buffer_post_id || r.buffer_status !== "sending") continue;
      const data = await buffer(env, `query { post(input: { id: ${gqlString(r.buffer_post_id)} }) { status externalLink error { message rawError } } }`);
      const p = data.post;
      // Check once only (free Buffer API budget); "sending" after the check stays as checked.
      r.buffer_status = p.status === "sending" ? "sending-checked" : p.status;
      if (p.externalLink) r.link = p.externalLink;
      if (p.status === "error") {
        r.ok = false;
        r.error = (p.error && (p.error.rawError || p.error.message)) || "Buffer could not publish the post";
      }
    }
    const okCount = list.filter((r) => r.ok).length;
    const status = okCount === list.length ? "published" : okCount ? "partial" : "failed";
    const error = list.filter((r) => !r.ok).map((r) => `${r.channel}: ${r.error}`).join("; ") || null;
    await env.DB.prepare("UPDATE posts SET status = ?, error = ?, channel_results = ? WHERE id = ?")
      .bind(status, error, JSON.stringify(list), post.id).run();
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
    env.DB.prepare("DELETE FROM images WHERE created_at < ?").bind(new Date(Date.now() - Math.max(2, s.image_retention_days) * 86400000).toISOString()),
  ]);
  await saveSettings(env, { last_cleanup_date: today });
}

// ---------- news sources ----------

const SOURCE_UA = "Mozilla/5.0 (compatible; NayaNewsAutopilot/1.0; +https://github.com)";
const BLOCKED_SOCIAL = {
  "x.com": "X (Twitter)", "twitter.com": "X (Twitter)", "linkedin.com": "LinkedIn", "facebook.com": "Facebook",
  "fb.com": "Facebook", "instagram.com": "Instagram", "threads.net": "Threads", "tiktok.com": "TikTok",
};
const googleNews = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-PK&gl=PK&ceid=PK:en`;

// Turn whatever the user pastes into a readable feed: RSS/Atom links as-is, websites and YouTube
// channels via their advertised feed, Telegram and Bluesky via their free public feeds, plain words
// as a Google News search. Platforms that block free reading get a clear explanation instead.
async function resolveSource(raw) {
  let input = raw.trim();
  if (!input) throw new HttpError(400, "Paste a website, feed link, channel link or topic words");
  if (!/^https?:\/\//i.test(input)) {
    if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(input)) input = `https://${input}`;
    else return { url: googleNews(input), kind: "topic", name: `Google News: ${input}`.slice(0, 80) };
  }
  let u;
  try {
    u = new URL(input);
  } catch {
    throw new HttpError(400, "That link doesn't look valid");
  }
  const host = u.hostname.replace(/^(www|m|mobile)\./, "");
  const blocked = Object.keys(BLOCKED_SOCIAL).find((h) => host === h || host.endsWith(`.${h}`));
  if (blocked) {
    throw new HttpError(400, `${BLOCKED_SOCIAL[blocked]} accounts can't be read for free (the platform blocks it). ` +
      "Add the outlet's website instead (for example dawn.com) and the system finds its news feed automatically, " +
      "or type the outlet's name as topic words to follow it through Google News.");
  }
  if (host === "t.me" || host === "telegram.me") {
    const name = u.pathname.split("/").filter(Boolean).filter((p) => p !== "s")[0];
    if (!name) throw new HttpError(400, "Use a public channel link like https://t.me/channelname");
    return { url: `https://t.me/s/${name}`, kind: "telegram", name: `Telegram: ${name}` };
  }
  if (host === "bsky.app") {
    const m = u.pathname.match(/^\/profile\/([^/]+)/);
    if (m) return { url: `https://bsky.app/profile/${m[1]}/rss`, kind: "rss", name: `Bluesky: ${m[1]}` };
  }
  let res;
  try {
    res = await fetch(u.toString(), { headers: { "user-agent": SOURCE_UA, accept: "application/rss+xml, application/atom+xml, text/html;q=0.9, */*;q=0.5" }, redirect: "follow" });
  } catch {
    throw new HttpError(400, "Couldn't open that link. Check the address and try again.");
  }
  const type = res.headers.get("content-type") || "";
  if (/xml|rss|atom/i.test(type)) {
    const head = (await res.text()).slice(0, 4000);
    if (/<(rss|feed|rdf:RDF)\b/i.test(head)) {
      const title = (head.match(/<title[^>]*>(?:<!\[CDATA\[)?([^<\]]+)/i) || [])[1];
      return { url: res.url, kind: "rss", name: (title || host).trim().slice(0, 80) };
    }
  }
  if (/html/i.test(type)) {
    let feedHref = null;
    let title = "";
    await new HTMLRewriter()
      .on('link[rel="alternate"]', {
        element(el) {
          const t = (el.getAttribute("type") || "").toLowerCase();
          if (!feedHref && (t.includes("rss") || t.includes("atom"))) feedHref = el.getAttribute("href");
        },
      })
      .on("title", { text(t) { if (title.length < 200) title += t.text; } })
      .transform(res)
      .arrayBuffer();
    if (feedHref) {
      const kind = host.endsWith("youtube.com") ? "youtube" : "rss";
      return { url: new URL(feedHref, res.url).toString(), kind, name: title.trim().slice(0, 80) || host };
    }
    return { url: googleNews(`site:${host}`), kind: "topic", name: `${host} (via Google News)` };
  }
  throw new HttpError(400, "Couldn't find news on that link. Paste the website address or its RSS link.");
}

// ---------- Buffer ----------

async function buffer(env, query) {
  if (!env.BUFFER_API_KEY) throw new HttpError(500, "BUFFER_API_KEY is not set on the Worker");
  await usage.addUsage(env, "buffer_api", 1);
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

async function imageBytes(env, id) {
  const row = await env.DB.prepare("SELECT data FROM images WHERE id = ?").bind(id).first();
  return row ? new Uint8Array(row.data) : await env.IMAGES.get(`img:${id}`, { type: "arrayBuffer" });
}

// Publish to every enabled destination: LinkedIn and Instagram directly, Buffer channels (X).
async function publishPost(env, origin, post, s) {
  const imageUrl = `${origin}/img/${post.id}.jpg`;
  const results = [];
  const cap = await usage.capacity(env, s);
  const skipped = [];
  if (s.publish_linkedin && s.li_token) {
    try {
      const r = await social.linkedinPublish(s, post, await imageBytes(env, post.id));
      results.push({ channel: s.li_name || "LinkedIn", service: "linkedin", ok: true, link: r.link, remote_id: r.remote_id });
    } catch (err) {
      results.push({ channel: s.li_name || "LinkedIn", service: "linkedin", ok: false, error: err.message });
    }
  }
  if (s.publish_instagram && s.ig_token && !cap.instagram) skipped.push("Instagram (100 posts/day reached)");
  if (s.publish_instagram && s.ig_token && cap.instagram) {
    try {
      const r = await social.instagramPublish(s, post, imageUrl);
      await usage.addUsage(env, "instagram_post", 1);
      results.push({ channel: `@${s.ig_username || "instagram"}`, service: "instagram", ok: true, link: r.link, remote_id: r.remote_id });
    } catch (err) {
      results.push({ channel: `@${s.ig_username || "instagram"}`, service: "instagram", ok: false, error: err.message });
    }
  }
  for (const ch of (s.buffer_channels || []).filter((c) => c.enabled)) {
    if (!cap.buffer.find((b) => b.id === ch.id)?.ok) {
      skipped.push(`${ch.service} ${ch.name} (Buffer's 50 posts/day or monthly API limit reached)`);
      continue;
    }
    // X allows 280 characters, so Buffer channels for X get the short caption.
    const text = ch.service === "twitter" || ch.service === "x" ? post.caption_short || post.caption : post.caption;
    const q = `mutation { createPost(input: { text: ${gqlString(text)}, channelId: ${gqlString(ch.id)}, schedulingType: automatic, mode: shareNow, assets: [{ image: { url: ${gqlString(imageUrl)} } }] }) { __typename ... on PostActionSuccess { post { id status dueAt externalLink error { message rawError } } } ... on MutationError { message } } }`;
    try {
      const data = await buffer(env, q);
      const r = data.createPost;
      if (r.post && r.post.status !== "error") {
        await usage.addUsage(env, `buffer_post:${ch.id}`, 1, usage.localDay(s));
        results.push({ channel: ch.name, service: ch.service, ok: true, buffer_post_id: r.post.id, buffer_status: r.post.status, link: r.post.externalLink || null });
      } else if (r.post) {
        const why = (r.post.error && (r.post.error.rawError || r.post.error.message)) || "Buffer could not publish the post";
        results.push({ channel: ch.name, service: ch.service, ok: false, buffer_post_id: r.post.id, error: why });
      } else results.push({ channel: ch.name, service: ch.service, ok: false, error: r.message || r.__typename });
    } catch (err) {
      results.push({ channel: ch.name, service: ch.service, ok: false, error: err.message });
    }
  }
  if (!results.length) {
    const why = skipped.length ? `Daily limits reached: ${skipped.join("; ")}` : "No destination is connected. Open Channels in the panel and connect Instagram or Buffer.";
    return { status: "failed", error: why, results };
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

async function aiText(env, { system, user, size = "large" }) {
  const model = TEXT_MODELS[size] || TEXT_MODELS.large;
  const input = {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: size === "small" ? 400 : 1800,
    temperature: 0.4,
  };
  let res;
  try {
    res = await env.AI.run(model, { ...input, response_format: { type: "json_object" } });
  } catch {
    res = await env.AI.run(model, input); // model without JSON mode
  }
  const text = typeof res.response === "string" ? res.response : JSON.stringify(res.response);
  await usage.addUsage(env, "neurons", size === "small" ? 30 : 250);
  return { text, model };
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
    settings: publicSettings(s),
    feeds: feeds.results,
    posts: posts.results.map((r) => rowToPost(r, origin)),
    runs: runs.results,
    stats: {
      published_today: today, published_total: total?.n || 0, next_run: nextRunEstimate(s), now: nowIso(),
      neurons_used: await usage.getUsage(env, "neurons"), neurons_total: usage.NEURONS_PER_DAY,
      buffer_api_left: await usage.bufferApiLeft(env),
    },
    image_models: images.IMAGE_MODELS.map((m) => ({ id: m.id, label: m.label, cost: m.cost })),
    assets: { logo: s.asset_logo, frame: s.asset_frame },
    config: {
      buffer: Boolean(env.BUFFER_API_KEY),
      github: Boolean(env.GH_TOKEN && env.GH_REPO),
      queue: Boolean(env.QUEUE_URL),
      linkedin_app: Boolean(env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET),
      instagram_app: Boolean(env.IG_APP_ID && (env.IG_APP_SECRET || s.ig_app_secret)),
      instagram_app_id: Boolean(env.IG_APP_ID),
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
  // Image hosts like Buffer probe with HEAD before downloading, so answer both.
  const read = method === "GET" || method === "HEAD";
  let m = path.match(/^\/img\/([a-f0-9]{8,32})\.jpg$/);
  if (m && read) {
    const row = await env.DB.prepare("SELECT data FROM images WHERE id = ?").bind(m[1]).first();
    // D1 hands BLOBs back as an array of byte values; turn it back into raw bytes.
    const data = row ? new Uint8Array(row.data) : await env.IMAGES.get(`img:${m[1]}`, { type: "arrayBuffer" });
    if (!data) return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
    const bytes = data.byteLength ?? data.length;
    return new Response(method === "HEAD" ? null : data, {
      headers: { "content-type": "image/jpeg", "content-length": String(bytes), "cache-control": "public, max-age=86400" },
    });
  }
  m = path.match(/^\/asset\/ref\/([A-Za-z0-9_]{2,40})$/);
  if (m && read) {
    const obj = await env.IMAGES.getWithMetadata(`ref:${m[1]}`, { type: "arrayBuffer" });
    if (!obj.value) return new Response("not found", { status: 404 });
    return new Response(obj.value, { headers: { "content-type": obj.metadata?.type || "image/png", "cache-control": "no-cache" } });
  }
  m = path.match(/^\/asset\/(logo|frame)\.png$/);
  if (m && read) {
    const data = await env.IMAGES.get(`asset:${m[1]}`, { type: "arrayBuffer" });
    if (!data) return new Response("not found", { status: 404 });
    return new Response(data, { headers: { "content-type": "image/png", "cache-control": "no-cache" } });
  }
  if (path === "/") return html((await hasSession(request, env)) ? DASHBOARD_HTML : LOGIN_HTML);
  if (path === "/api/login" && method === "POST") {
    const { password } = await body(request);
    const s = await getSettings(env);
    if (!(await checkPassword(env, s, password))) {
      await new Promise((r) => setTimeout(r, 1000));
      throw new HttpError(401, "Wrong password");
    }
    return json({ ok: true }, 200, { "set-cookie": sessionCookie(await makeSession(env, s)) });
  }
  if (path === "/api/logout" && method === "POST") {
    return json({ ok: true }, 200, { "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
  }

  // Connect LinkedIn / Instagram (start requires a panel login; callbacks are verified by signed state)
  m = path.match(/^\/oauth\/(linkedin|instagram)\/(start|callback)$/);
  if (m && method === "GET") return oauthRoute(request, env, url, m[1], m[2]);

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

function messagePage(title, text, ok) {
  return html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<body style="font:16px system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:#f4f5f7;color:#16181d">
<div style="background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:28px;max-width:440px;text-align:center">
<div style="font-size:40px">${ok ? "&#10003;" : "&#9888;"}</div><h2 style="margin:8px 0">${title}</h2><p style="color:#6b7280">${text}</p>
<a href="/" style="display:inline-block;margin-top:10px;padding:10px 18px;border-radius:10px;background:#16181d;color:#fff;text-decoration:none">Back to the control panel</a></div></body>`);
}

async function oauthRoute(request, rawEnv, url, provider, step) {
  const origin = url.origin;
  const st = await getSettings(rawEnv);
  const env = { ...rawEnv, IG_APP_SECRET: rawEnv.IG_APP_SECRET || st.ig_app_secret };
  const ready = provider === "linkedin" ? env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET : env.IG_APP_ID && env.IG_APP_SECRET;
  if (!ready) return messagePage("App not set up yet", `The ${provider} app keys are not configured on the server.`, false);
  if (step === "start") {
    if (!(await hasSession(request, env))) return Response.redirect(`${origin}/`, 302);
    const state = await social.makeState(env, provider);
    const target = provider === "linkedin" ? social.linkedinAuthUrl(env, origin, state) : social.instagramAuthUrl(env, origin, state);
    return Response.redirect(target, 302);
  }
  const code = url.searchParams.get("code");
  if (!code || !(await social.checkState(env, provider, url.searchParams.get("state")))) {
    const why = url.searchParams.get("error_description") || url.searchParams.get("error") || "The login link expired. Start again from the panel.";
    return messagePage("Not connected", why, false);
  }
  try {
    const saved = provider === "linkedin" ? await social.linkedinExchange(env, origin, code) : await social.instagramExchange(env, origin, code);
    // Posting directly now: switch off the same network in Buffer so posts are not doubled.
    const service = provider === "linkedin" ? "linkedin" : "instagram";
    saved.buffer_channels = (st.buffer_channels || []).map((c) => (c.service === service ? { ...c, enabled: false } : c));
    await saveSettings(rawEnv, saved);
    const who = saved.li_name || (saved.ig_username ? `@${saved.ig_username}` : "");
    return messagePage(`${provider === "linkedin" ? "LinkedIn" : "Instagram"} connected`, `New posts will now go to ${who} automatically.`, true);
  } catch (err) {
    return messagePage("Not connected", err.message, false);
  }
}

async function pipelineRoute(request, env, path, method, origin) {
  let m;
  if (path === "/pipeline/config" && method === "GET") {
    const s = await getSettings(env);
    const [feeds, seen, recent, today] = await Promise.all([
      env.DB.prepare("SELECT id, url, name, category, enabled, kind, interval_minutes, last_fetched_at FROM feeds WHERE enabled = 1").all(),
      env.DB.prepare("SELECT guid FROM seen").all(),
      env.DB.prepare("SELECT title_key FROM seen WHERE title_key IS NOT NULL ORDER BY seen_at DESC LIMIT 400").all(),
      publishedToday(env, s),
    ]);
    return json({
      settings: publicSettings(s),
      feeds: feeds.results,
      seen: seen.results.map((r) => r.guid),
      recent_title_keys: recent.results.map((r) => r.title_key),
      remaining_today: await remainingToday(env, s),
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
  if (path === "/pipeline/ai/image" && method === "POST") {
    const b = await body(request);
    const s = await getSettings(env);
    return json(await images.generate(env, { ...b, model: b.model || s.image_model, posts_left: await postsLeftUtc(env, s) }));
  }
  if (path === "/pipeline/ai/text" && method === "POST") return json(await aiText(env, await body(request)));
  if ((m = path.match(/^\/pipeline\/images\/([a-f0-9]{8,32})$/)) && method === "PUT") {
    const s = await getSettings(env);
    const data = await request.arrayBuffer();
    if (data.byteLength < 1000 || data.byteLength > 5_000_000) throw new HttpError(400, "image size out of range");
    if (data.byteLength > 1_900_000) throw new HttpError(400, "image too large");
    await env.DB.prepare("INSERT OR REPLACE INTO images (id, data, created_at) VALUES (?, ?, ?)").bind(m[1], data, nowIso()).run();
    return json({ url: `${origin}/img/${m[1]}.jpg` });
  }
  if (path === "/pipeline/posts" && method === "POST") {
    const p = await body(request);
    const s = await getSettings(env);
    const status = p.mode === "live" ? (s.approval_mode ? "draft" : "publishing") : "test";
    await env.DB.prepare(
      `INSERT INTO posts (id, created_at, status, source_url, source_name, source_title, headline, highlights, caption, hashtags,
        image_key, image_prompt, alt_text, category, image_model, text_model, run_id, caption_short)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        p.id, nowIso(), status, p.source_url || null, p.source_name || null, p.source_title || null, p.headline || "",
        JSON.stringify(p.highlights || []), p.caption || "", JSON.stringify(p.hashtags || []), `img:${p.id}`,
        p.image_prompt || null, p.alt_text || null, p.category || null, p.image_model || null, p.text_model || null, p.run_id || null,
        p.caption_short || null,
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
    const mode = ["live", "collect"].includes(b.mode) ? b.mode : "test";
    const articleUrl = String(b.article_url || "").trim();
    if (articleUrl && !/^https?:\/\/\S+$/.test(articleUrl)) throw new HttpError(400, "article URL must start with http(s)://");
    const busy = await env.DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE status IN ('dispatched','running')").first();
    if (busy?.n) throw new HttpError(409, "A run is already in progress. Wait for it to finish.");
    return json({ ok: true, run_id: await dispatch(env, mode, "panel", articleUrl) });
  }
  if (path === "/api/queue" && method === "GET") {
    if (!env.QUEUE_URL) return json({ items: [], configured: false });
    const res = await fetch(`${env.QUEUE_URL}?action=list&limit=100`, { redirect: "follow" });
    const data = await res.json().catch(() => ({ ok: false, error: `queue sheet answered HTTP ${res.status}` }));
    if (!data.ok) throw new HttpError(502, `Queue sheet: ${data.error || "unavailable"}`);
    return json({ items: data.items, configured: true });
  }
  if (path === "/api/queue/remove" && method === "POST") {
    if (!env.QUEUE_URL) throw new HttpError(400, "Queue sheet is not connected");
    const { link } = await body(request);
    const res = await fetch(env.QUEUE_URL, { method: "POST", redirect: "follow", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "remove", link, result: "removed in panel" }) });
    const data = await res.json().catch(() => ({ ok: false }));
    if (!data.ok) throw new HttpError(502, "Queue sheet did not accept the change");
    return json({ ok: true });
  }
  if (path === "/api/channels/refresh" && method === "POST") return json({ channels: await refreshChannels(env) });
  if (path === "/api/password" && method === "POST") {
    const b = await body(request);
    const s = await getSettings(env);
    if (!(await checkPassword(env, s, b.current))) throw new HttpError(400, "Current password is wrong");
    const next = String(b.new_password || "");
    if (next.length < 10) throw new HttpError(400, "New password must be at least 10 characters");
    const panel_password_hash = await hashPassword(next);
    await saveSettings(env, { panel_password_hash });
    return json({ ok: true }, 200, { "set-cookie": sessionCookie(await makeSession(env, { ...s, panel_password_hash })) });
  }
  if (path === "/api/app-secret" && method === "POST") {
    const b = await body(request);
    const secret = String(b.secret || "").trim();
    if (b.provider !== "instagram" || !/^[a-f0-9]{24,64}$/i.test(secret)) throw new HttpError(400, "That doesn't look like an Instagram app secret (32 letters and numbers).");
    await saveSettings(env, { ig_app_secret: secret });
    return json({ ok: true });
  }
  if (path === "/api/destinations" && method === "POST") {
    const b = await body(request);
    const patch = {};
    if ("linkedin" in b) patch.publish_linkedin = Boolean(b.linkedin);
    if ("instagram" in b) patch.publish_instagram = Boolean(b.instagram);
    if (b.disconnect === "linkedin") Object.assign(patch, { li_token: null, li_expires: null, li_person: null, li_name: null });
    if (b.disconnect === "instagram") Object.assign(patch, { ig_token: null, ig_expires: null, ig_token_at: null, ig_user_id: null, ig_username: null });
    await saveSettings(env, patch);
    return json({ ok: true });
  }
  if (path === "/api/channels" && method === "POST") {
    const { id, enabled } = await body(request);
    const s = await getSettings(env);
    const channels = (s.buffer_channels || []).map((c) => (c.id === id ? { ...c, enabled: Boolean(enabled) } : c));
    await saveSettings(env, { buffer_channels: channels });
    return json({ ok: true });
  }
  if (path === "/api/feeds" && method === "POST") {
    const b = await body(request);
    const src = await resolveSource(String(b.url || ""));
    const interval = Math.max(0, Math.min(1440, Number(b.interval_minutes) || 0));
    await env.DB.prepare("INSERT INTO feeds (url, name, category, enabled, kind, interval_minutes, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)")
      .bind(src.url, String(b.name || "").trim() || src.name || null, String(b.category || "").trim() || null, src.kind, interval, nowIso())
      .run()
      .catch(() => {
        throw new HttpError(409, "That source is already in the list");
      });
    return json({ ok: true, ...src });
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
      if ("interval_minutes" in b) fields.interval_minutes = Math.max(0, Math.min(1440, Number(b.interval_minutes) || 0));
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
      const hasImage = (await env.DB.prepare("SELECT 1 AS x FROM images WHERE id = ?").bind(row.id).first()) ||
        (await env.IMAGES.get(`img:${row.id}`, { type: "stream" }).then((v) => (v ? (v.cancel(), true) : false)));
      if (!hasImage) throw new HttpError(410, "Image has expired; run the pipeline again for this story");
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
      await env.DB.batch([
        env.DB.prepare("DELETE FROM images WHERE id = ?").bind(row.id),
        env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(row.id),
      ]);
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
