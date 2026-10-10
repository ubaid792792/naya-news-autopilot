// Image generation on Cloudflare Workers AI with "auto" model choice inside the free daily allowance.
import { addUsage, getUsage, NEURON_RESERVE, NEURONS_PER_DAY } from "./usage.js";

// Best first. cost = estimated neurons for one 1024x1232 image (6 tiles); refCost per reference picture.
export const IMAGE_MODELS = [
  { id: "@cf/leonardo/lucid-origin", label: "Leonardo Lucid Origin", cost: 4116, refCost: 0, refs: false, kind: "json" },
  { id: "@cf/leonardo/phoenix-1.0", label: "Leonardo Phoenix 1.0", cost: 3430, refCost: 0, refs: false, kind: "binary" },
  { id: "@cf/black-forest-labs/flux-2-klein-9b", label: "FLUX.2 klein 9B", cost: 1411, refCost: 182, refs: true, kind: "multipart" },
  { id: "@cf/black-forest-labs/flux-2-klein-4b", label: "FLUX.2 klein 4B", cost: 156, refCost: 6, refs: true, kind: "multipart" },
  { id: "@cf/black-forest-labs/flux-1-schnell", label: "FLUX.1 schnell", cost: 67, refCost: 0, refs: false, kind: "json" },
];
const DEFAULT = "@cf/black-forest-labs/flux-2-klein-4b";
const byId = (id) => IMAGE_MODELS.find((m) => m.id === id);
const costOf = (m, refs) => m.cost + (m.refs ? refs * m.refCost : 0);

// Spend spare free allowance on better models while keeping enough for the rest of today's posts.
export async function chooseModels(env, preferred, refsCount, postsLeft) {
  const used = await getUsage(env, "neurons");
  const budget = NEURONS_PER_DAY - NEURON_RESERVE - used;
  const usable = IMAGE_MODELS.filter((m) => !refsCount || m.refs || m.id === DEFAULT);
  if (preferred && preferred !== "auto" && byId(preferred)) {
    const first = byId(preferred);
    return [first, ...IMAGE_MODELS.filter((m) => m !== first && m.cost < first.cost && (!refsCount || m.refs))];
  }
  const base = costOf(byId(DEFAULT), refsCount);
  const later = Math.max(0, postsLeft - 1) * base;
  const ordered = usable.filter((m) => costOf(m, refsCount) + later <= budget);
  const cheap = IMAGE_MODELS.filter((m) => costOf(m, refsCount) <= Math.max(budget, 0) && !ordered.includes(m) && (!refsCount || m.refs));
  const list = [...ordered, ...cheap];
  return list.length ? list : [byId(DEFAULT), byId("@cf/black-forest-labs/flux-1-schnell")];
}

function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function runModel(env, m, prompt, refs, width, height) {
  if (m.kind === "multipart") {
    const form = new FormData();
    form.append("prompt", prompt.slice(0, 2000));
    form.append("width", String(width));
    form.append("height", String(height));
    refs.slice(0, 4).forEach((b64, i) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      form.append(`input_image_${i}`, new Blob([bytes], { type: "image/png" }), `ref${i}.png`);
    });
    const packed = new Response(form);
    const res = await env.AI.run(m.id, { multipart: { body: packed.body, contentType: packed.headers.get("content-type") } });
    return res?.image;
  }
  if (m.kind === "binary") {
    const res = await env.AI.run(m.id, { prompt: prompt.slice(0, 2000), width, height, num_steps: 25, guidance: 4,
      negative_prompt: "people, faces, text, letters, watermark, logo, blurry, dark, gloomy" });
    const bytes = new Uint8Array(await new Response(res).arrayBuffer());
    return bytes.length ? toBase64(bytes) : null;
  }
  const input = m.id.includes("schnell") ? { prompt: prompt.slice(0, 2000), steps: 4 } : { prompt: prompt.slice(0, 2000), width, height, num_steps: 25 };
  const res = await env.AI.run(m.id, input);
  return res?.image;
}

// prompt_refs carries "reference image N" wording for models that take reference pictures;
// prompt_plain describes flags and buildings in words for the others.
export async function generate(env, { prompt, prompt_plain, references = [], model, width = 1024, height = 1232, posts_left = 1 }) {
  const models = await chooseModels(env, model, references.length, posts_left);
  const errors = [];
  for (const m of models) {
    const useRefs = m.refs && references.length > 0;
    try {
      const image = await runModel(env, m, useRefs ? prompt : prompt_plain || prompt, useRefs ? references : [], width, height);
      if (!image) throw new Error("no image returned");
      await addUsage(env, "neurons", costOf(m, useRefs ? references.length : 0));
      await addUsage(env, `images:${m.id}`, 1);
      return { image, model: m.id + (useRefs ? ` +${references.length} refs` : "") };
    } catch (err) {
      errors.push(`${m.label}: ${String(err.message || err).slice(0, 160)}`);
    }
  }
  const e = new Error(`all image models failed: ${errors.join(" | ")}`);
  e.status = 502;
  throw e;
}
