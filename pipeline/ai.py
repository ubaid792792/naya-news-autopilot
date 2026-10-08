"""Text and image generation with free-tier fallbacks.

Text:  Gemini models in order (free tier, no card) -> Cloudflare Workers AI LLM via the Worker.
Image: Workers AI FLUX.2 klein -> Workers AI FLUX.1 schnell -> Pollinations (anonymous, free).
"""
from __future__ import annotations

import json
import logging
import re
import time
import urllib.parse

import requests

from . import flags
from .worker_api import WorkerAPI

log = logging.getLogger("ai")

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
DEFAULT_TEXT_MODELS = ["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-2.5-flash", "gemini-2.5-flash-lite"]
IMAGE_MODELS = ["@cf/black-forest-labs/flux-2-klein-4b", "@cf/black-forest-labs/flux-1-schnell"]


def parse_json(text: str) -> dict:
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start >= 0 and end > start:
            return json.loads(text[start:end + 1])
        raise


class TextAI:
    def __init__(self, gemini_key: str, worker: WorkerAPI, models: list[str] | None = None):
        self.key = gemini_key
        self.worker = worker
        self.models = models or DEFAULT_TEXT_MODELS
        self.exhausted: set[str] = set()
        self.used: list[str] = []

    def _gemini(self, model: str, system: str, user: str) -> str:
        body = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user}]}],
            "generationConfig": {"responseMimeType": "application/json", "temperature": 0.6},
        }
        for attempt in range(2):
            r = requests.post(GEMINI_URL.format(model=model), json=body, timeout=120,
                              headers={"x-goog-api-key": self.key})
            if r.status_code in (500, 502, 503, 504) and attempt == 0:
                time.sleep(5)
                continue
            if r.status_code in (404, 429, 403, 400):
                self.exhausted.add(model)
                raise RuntimeError(f"{model}: HTTP {r.status_code} {r.text[:160]}")
            r.raise_for_status()
            cand = (r.json().get("candidates") or [{}])[0]
            parts = cand.get("content", {}).get("parts", [])
            text = "".join(p.get("text", "") for p in parts if not p.get("thought"))
            if not text:
                raise RuntimeError(f"{model}: empty response ({cand.get('finishReason')})")
            return text
        raise RuntimeError(f"{model}: unavailable")

    def json(self, system: str, user: str) -> dict:
        errors = []
        if self.key:
            for model in self.models:
                if model in self.exhausted:
                    continue
                try:
                    data = parse_json(self._gemini(model, system, user))
                    self.used.append(model)
                    return data
                except Exception as exc:  # noqa: BLE001 - try the next free model
                    errors.append(str(exc))
                    log.warning("text model failed: %s", exc)
        try:
            data = parse_json(self.worker.llm(system, user + "\n\nReturn only valid JSON."))
            self.used.append("workers-ai")
            return data
        except Exception as exc:  # noqa: BLE001
            errors.append(f"workers-ai: {exc}")
        raise RuntimeError("all text models failed: " + " | ".join(errors))


def generate_image(worker: WorkerAPI, prompt: str, preferred: str | None = None,
                   flag_codes: list[str] | None = None) -> tuple[bytes, str]:
    """Try each free image model. FLUX.2 models also get the real flag images as references."""
    models = [preferred] + [m for m in IMAGE_MODELS if m != preferred] if preferred else IMAGE_MODELS
    refs: list[str] = []
    errors = []
    for model in models:
        use_refs = "flux-2" in model and bool(flag_codes)
        flag_text, used = flags.flag_prompt(flag_codes or [], with_reference=use_refs)
        if use_refs and not refs:
            refs = flags.flag_images(used)
        if use_refs and len(refs) != len(used):
            flag_text, used = flags.flag_prompt(flag_codes or [], with_reference=False)
        full = f"{prompt} {flag_text}".strip()
        try:
            image = worker.generate_image(full, 1024, 1232, model, refs if use_refs and refs else None)
            return image, model + (" +flag refs" if use_refs and refs else "")
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{model}: {exc}")
            log.warning("image model failed: %s", exc)
    try:
        flag_text, _ = flags.flag_prompt(flag_codes or [], with_reference=False)
        full = f"{prompt} {flag_text}".strip()
        url = ("https://image.pollinations.ai/prompt/" + urllib.parse.quote(full[:1200])
               + "?width=1024&height=1232&nologo=true&model=flux&seed=" + str(int(time.time()) % 100000))
        r = requests.get(url, timeout=180)
        if r.ok and r.headers.get("content-type", "").startswith("image/"):
            return r.content, "pollinations"
        errors.append(f"pollinations: HTTP {r.status_code}")
    except requests.RequestException as exc:
        errors.append(f"pollinations: {exc}")
    raise RuntimeError("all image models failed: " + " | ".join(errors))
