// Daily usage counters (D1 table `usage`) for free-tier limits: Cloudflare AI neurons, Buffer posts
// per channel, Buffer API calls, Instagram API posts.

export const NEURONS_PER_DAY = 10000; // Workers AI free allocation, resets 00:00 UTC
export const NEURON_RESERVE = 1500; // kept back for the text fallback model
export const BUFFER_POSTS_PER_CHANNEL_DAY = 50;
export const BUFFER_API_PER_30_DAYS = 3000;
export const INSTAGRAM_POSTS_PER_DAY = 100;

export const utcDay = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

export async function addUsage(env, key, n = 1, day = utcDay()) {
  await env.DB.prepare("INSERT INTO usage (day, key, n) VALUES (?, ?, ?) ON CONFLICT(day, key) DO UPDATE SET n = n + excluded.n")
    .bind(day, key, n)
    .run();
}

export async function getUsage(env, key, day = utcDay()) {
  const row = await env.DB.prepare("SELECT n FROM usage WHERE day = ? AND key = ?").bind(day, key).first();
  return row ? row.n : 0;
}

export async function usageSince(env, key, sinceDay) {
  const row = await env.DB.prepare("SELECT SUM(n) AS n FROM usage WHERE day >= ? AND key = ?").bind(sinceDay, key).first();
  return row?.n || 0;
}

// Buffer counts its daily limit by the channel's own (local) day.
export const localDay = (s, ms = Date.now()) => new Date(ms + s.tz_offset_minutes * 60000).toISOString().slice(0, 10);

export async function bufferApiLeft(env) {
  const used = await usageSince(env, "buffer_api", utcDay(Date.now() - 29 * 86400000));
  return BUFFER_API_PER_30_DAYS - 50 - used; // keep a small margin for channel refreshes
}

// Which destinations can still take a post right now.
export async function capacity(env, s) {
  const day = localDay(s);
  const apiLeft = await bufferApiLeft(env);
  const buffer = [];
  for (const ch of (s.buffer_channels || []).filter((c) => c.enabled)) {
    const used = await getUsage(env, `buffer_post:${ch.id}`, day);
    buffer.push({ id: ch.id, ok: apiLeft > 0 && used < BUFFER_POSTS_PER_CHANNEL_DAY, used });
  }
  const igUsed = await getUsage(env, "instagram_post");
  const instagram = Boolean(s.publish_instagram && s.ig_token) && igUsed < INSTAGRAM_POSTS_PER_DAY;
  const linkedin = Boolean(s.publish_linkedin && s.li_token);
  return { buffer, instagram, linkedin, any: buffer.some((b) => b.ok) || instagram || linkedin, bufferApiLeft: apiLeft, igUsed };
}
