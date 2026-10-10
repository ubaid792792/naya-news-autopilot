// Direct posting to LinkedIn (Share on LinkedIn API) and Instagram (Instagram API with Instagram
// Login), using the user's own free developer apps. Tokens stay in D1 and are never sent to the panel.

const LINKEDIN_VERSION = "202606";

export const SECRET_SETTING_KEYS = ["li_token", "ig_token", "ig_app_secret", "panel_password_hash"];

// ---------- OAuth state (signed, short-lived) ----------

async function sign(secret, text) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function makeState(env, provider) {
  const exp = Date.now() + 15 * 60000;
  return `${provider}.${exp}.${await sign(env.PIPELINE_SECRET, `oauth:${provider}:${exp}`)}`;
}

export async function checkState(env, provider, state) {
  const [p, exp, sig] = String(state || "").split(".");
  if (p !== provider || !exp || Number(exp) < Date.now()) return false;
  return sig === (await sign(env.PIPELINE_SECRET, `oauth:${provider}:${exp}`));
}

// ---------- LinkedIn ----------

export function linkedinAuthUrl(env, origin, state) {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: env.LINKEDIN_CLIENT_ID,
    redirect_uri: `${origin}/oauth/linkedin/callback`,
    state,
    scope: "openid profile w_member_social",
  });
  return `https://www.linkedin.com/oauth/v2/authorization?${q}`;
}

export async function linkedinExchange(env, origin, code) {
  const res = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${origin}/oauth/linkedin/callback`,
      client_id: env.LINKEDIN_CLIENT_ID,
      client_secret: env.LINKEDIN_CLIENT_SECRET,
    }),
  });
  const tok = await res.json();
  if (!tok.access_token) throw new Error(`LinkedIn login failed: ${JSON.stringify(tok).slice(0, 200)}`);
  const me = await (await fetch("https://api.linkedin.com/v2/userinfo", { headers: { authorization: `Bearer ${tok.access_token}` } })).json();
  if (!me.sub) throw new Error("LinkedIn did not return the member id");
  return {
    li_token: tok.access_token,
    li_expires: new Date(Date.now() + (tok.expires_in || 5184000) * 1000).toISOString(),
    li_person: `urn:li:person:${me.sub}`,
    li_name: me.name || "",
  };
}

// LinkedIn's "little text" format treats these characters as markup; escape them so the text is
// posted as written (an unescaped bracket can silently cut the post short). # stays for hashtags.
function littleText(text) {
  return String(text).replace(/[\\|{}@[\]()<>*_~]/g, (c) => `\\${c}`);
}

function liHeaders(token, json = true) {
  return {
    authorization: `Bearer ${token}`,
    "linkedin-version": LINKEDIN_VERSION,
    "x-restli-protocol-version": "2.0.0",
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

export async function linkedinPublish(s, post, imageBytes) {
  if (!s.li_token) throw new Error("LinkedIn is not connected. Click Connect LinkedIn in the panel.");
  if (s.li_expires && Date.parse(s.li_expires) < Date.now()) throw new Error("LinkedIn login expired. Click Reconnect LinkedIn in the panel.");
  const init = await fetch("https://api.linkedin.com/rest/images?action=initializeUpload", {
    method: "POST",
    headers: liHeaders(s.li_token),
    body: JSON.stringify({ initializeUploadRequest: { owner: s.li_person } }),
  });
  const initData = await init.json().catch(() => ({}));
  if (!init.ok || !initData.value) throw new Error(`LinkedIn image upload refused (${init.status}): ${JSON.stringify(initData).slice(0, 200)}`);
  const up = await fetch(initData.value.uploadUrl, { method: "PUT", headers: { authorization: `Bearer ${s.li_token}` }, body: imageBytes });
  if (!up.ok) throw new Error(`LinkedIn image upload failed (${up.status})`);
  const res = await fetch("https://api.linkedin.com/rest/posts", {
    method: "POST",
    headers: liHeaders(s.li_token),
    body: JSON.stringify({
      author: s.li_person,
      commentary: littleText(post.caption),
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      content: { media: { id: initData.value.image, title: post.headline || "", altText: (post.alt_text || post.headline || "").slice(0, 300) } },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    }),
  });
  if (res.status !== 201) throw new Error(`LinkedIn post refused (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const urn = res.headers.get("x-restli-id");
  return { link: urn ? `https://www.linkedin.com/feed/update/${urn}` : null, remote_id: urn };
}

// ---------- Instagram (Instagram Login) ----------

export function instagramAuthUrl(env, origin, state) {
  const q = new URLSearchParams({
    client_id: env.IG_APP_ID,
    redirect_uri: `${origin}/oauth/instagram/callback`,
    response_type: "code",
    scope: "instagram_business_basic,instagram_business_content_publish",
    state,
  });
  return `https://www.instagram.com/oauth/authorize?${q}`;
}

export async function instagramExchange(env, origin, code) {
  const res = await fetch("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.IG_APP_ID,
      client_secret: env.IG_APP_SECRET,
      grant_type: "authorization_code",
      redirect_uri: `${origin}/oauth/instagram/callback`,
      code: code.replace(/#_$/, ""),
    }),
  });
  const short = await res.json();
  if (!short.access_token) throw new Error(`Instagram login failed: ${JSON.stringify(short).slice(0, 200)}`);
  const longRes = await fetch(`https://graph.instagram.com/access_token?${new URLSearchParams({
    grant_type: "ig_exchange_token", client_secret: env.IG_APP_SECRET, access_token: short.access_token })}`);
  const long = await longRes.json();
  if (!long.access_token) throw new Error(`Instagram long-lived token failed: ${JSON.stringify(long).slice(0, 200)}`);
  const me = await (await fetch(`https://graph.instagram.com/me?fields=user_id,username&access_token=${encodeURIComponent(long.access_token)}`)).json();
  return {
    ig_token: long.access_token,
    ig_expires: new Date(Date.now() + (long.expires_in || 5184000) * 1000).toISOString(),
    ig_token_at: new Date().toISOString(),
    ig_user_id: String(me.user_id || short.user_id),
    ig_username: me.username || "",
  };
}

// Instagram tokens last 60 days and can be renewed without the user once they are a day old.
export async function instagramRefresh(s) {
  if (!s.ig_token || !s.ig_expires) return null;
  const left = Date.parse(s.ig_expires) - Date.now();
  const age = Date.now() - Date.parse(s.ig_token_at || 0);
  if (left > 20 * 86400000 || age < 86400000) return null;
  const res = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(s.ig_token)}`);
  const data = await res.json();
  if (!data.access_token) throw new Error(`Instagram token refresh failed: ${JSON.stringify(data).slice(0, 200)}`);
  return {
    ig_token: data.access_token,
    ig_expires: new Date(Date.now() + (data.expires_in || 5184000) * 1000).toISOString(),
    ig_token_at: new Date().toISOString(),
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function instagramPublish(s, post, imageUrl) {
  if (!s.ig_token) throw new Error("Instagram is not connected. Click Connect Instagram in the panel.");
  const base = `https://graph.instagram.com/${s.ig_user_id}`;
  const form = (o) => new URLSearchParams({ ...o, access_token: s.ig_token });
  const created = await (await fetch(`${base}/media`, {
    method: "POST",
    body: form({ image_url: imageUrl, caption: String(post.caption).slice(0, 2200), alt_text: (post.alt_text || post.headline || "").slice(0, 1000) }),
  })).json();
  if (!created.id) throw new Error(`Instagram refused the image: ${JSON.stringify(created.error || created).slice(0, 200)}`);
  // Wait until Instagram has processed the image before publishing it.
  for (let i = 0; i < 10; i++) {
    const st = await (await fetch(`https://graph.instagram.com/${created.id}?fields=status_code&access_token=${encodeURIComponent(s.ig_token)}`)).json();
    if (st.status_code === "FINISHED") break;
    if (st.status_code === "ERROR" || st.status_code === "EXPIRED") throw new Error(`Instagram could not process the image (${st.status_code})`);
    await wait(2000);
  }
  const pub = await (await fetch(`${base}/media_publish`, { method: "POST", body: form({ creation_id: created.id }) })).json();
  if (!pub.id) throw new Error(`Instagram publish failed: ${JSON.stringify(pub.error || pub).slice(0, 200)}`);
  const info = await (await fetch(`https://graph.instagram.com/${pub.id}?fields=permalink&access_token=${encodeURIComponent(s.ig_token)}`)).json();
  return { link: info.permalink || null, remote_id: pub.id };
}
