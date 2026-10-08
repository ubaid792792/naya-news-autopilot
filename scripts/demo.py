"""Render demo posts from saved writer outputs (JSON) without the Worker.

Images come from the official FLUX.2 [klein] 4B demo on Hugging Face (the same model the
system runs on Cloudflare Workers AI), so the preview matches production quality.
Usage: .venv/bin/python scripts/demo.py out/demo/*.json
"""
from __future__ import annotations

import io
import json
import sys
import time
import urllib.parse
from pathlib import Path

import requests
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from pipeline import prompts  # noqa: E402
from pipeline.feeds import Item  # noqa: E402
from pipeline.main import build_caption, clean_hashtags  # noqa: E402
from pipeline.render import render_card  # noqa: E402

SETTINGS = {
    "disclaimer": "Disclaimer: This content is for informational purposes only. Image is AI generated and just for reference.",
    "source_credit": "none", "fixed_hashtags": ["#NayaNews"], "hashtag_count": 9,
}


def klein(prompt: str, seed: int) -> bytes:
    from gradio_client import Client
    client = Client("black-forest-labs/FLUX.2-klein-4B", verbose=False)
    result, _ = client.predict(prompt=prompt, input_images=[], mode_choice="Distilled (4 steps)", seed=seed,
                               randomize_seed=False, width=848, height=1024, num_inference_steps=4,
                               guidance_scale=1.0, prompt_upsampling=False, api_name="/infer")
    path = result if isinstance(result, str) else result.get("path")
    return Path(path).read_bytes()


def pollinations(prompt: str, seed: int) -> bytes:
    url = ("https://image.pollinations.ai/prompt/" + urllib.parse.quote(prompt)
           + f"?width=1024&height=1232&nologo=true&model=flux&enhance=false&seed={seed}")
    for attempt in range(4):
        r = requests.get(url, timeout=240)
        if r.ok and r.headers.get("content-type", "").startswith("image/"):
            im = Image.open(io.BytesIO(r.content))
            buf = io.BytesIO()
            im.crop((0, 0, im.width, int(im.height * 0.93))).convert("RGB").save(buf, "JPEG", quality=95)
            return buf.getvalue()
        time.sleep(15 * (attempt + 1))
    raise RuntimeError(f"image failed: HTTP {r.status_code} {r.text[:200]}")


for i, path in enumerate(sys.argv[1:]):
    data = json.loads(Path(path).read_text())
    prompt = data["image_prompt"] + " " + prompts.image_suffix("none")
    bg = klein(prompt, 1000 + i)
    card = render_card(bg, data["headline"], data["highlights"], brand_name="Naya News")
    out = Path(path).with_suffix(".jpg")
    out.write_bytes(card)
    item = Item(guid=data["link"], title=data["headline"], link=data["link"], summary="", source=data["source"], published=None)
    caption = build_caption(data, item, SETTINGS, clean_hashtags(data["hashtags"], SETTINGS["fixed_hashtags"], 9))
    Path(path).with_suffix(".txt").write_text(caption + "\n\n---\nIMAGE PROMPT:\n" + prompt + "\n")
    print("rendered", out)
    time.sleep(6)
