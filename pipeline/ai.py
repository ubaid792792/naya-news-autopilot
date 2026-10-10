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

from . import references
from .worker_api import WorkerAPI

log = logging.getLogger("ai")

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
# Each Gemini model has its own free daily allowance, so a long chain keeps writing going all day.
DEFAULT_TEXT_MODELS = [
    "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-flash-latest",
    "gemini-3-flash-preview", "gemini-2.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite",
    "gemini-flash-lite-latest", "gemini-2.5-flash-lite", "gemma-4-31b-it", "gemma-4-26b-a4b-it",
]
LITE_TEXT_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-flash-lite-latest", "gemini-2.5-flash-lite"]


def parse_json(text: str) -> dict:
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        chunk = text[start:end + 1] if start >= 0 and end > start else text
        try:
            return json.loads(chunk)
        except json.JSONDecodeError:
            # Smaller models sometimes leave trailing commas or unquoted keys; repair instead of failing.
            from json_repair import repair_json
            data = repair_json(chunk, return_objects=True)
            if isinstance(data, dict) and data:
                return data
            raise


class TextAI:
    def __init__(self, gemini_key: str, worker: WorkerAPI, models: list[str] | None = None):
        self.key = gemini_key
        self.worker = worker
        self.models = models or DEFAULT_TEXT_MODELS
        self.exhausted: set[str] = set()
        self.used: list[str] = []

    def _gemini(self, model: str, system: str, user: str) -> str:
        if model.startswith("gemma"):
            # Gemma has no system instruction or JSON mode in the API: fold both into the prompt.
            body = {"contents": [{"role": "user", "parts": [{"text": f"{system}\n\n{user}\n\nReply with valid JSON only."}]}],
                    "generationConfig": {"temperature": 0.6}}
        else:
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

    def _worker(self, system: str, user: str, size: str) -> dict:
        data = parse_json(self.worker.llm(system, user + "\n\nReturn only valid JSON.", size))
        self.used.append(f"workers-ai-{size}")
        return data

    def json(self, system: str, user: str, cheap: bool = False) -> dict:
        """cheap=True (story picking): small Cloudflare model first, then lite Gemini models, saving the
        stronger Gemini allowance for writing. Otherwise: Gemini chain, then Cloudflare's large model."""
        errors = []
        if cheap:
            try:
                return self._worker(system, user, "small")
            except Exception as exc:  # noqa: BLE001
                errors.append(f"workers-ai-small: {exc}")
        models = LITE_TEXT_MODELS if cheap else self.models
        if self.key:
            for model in models:
                if model in self.exhausted:
                    continue
                try:
                    data = parse_json(self._gemini(model, system, user))
                    self.used.append(model)
                    return data
                except Exception as exc:  # noqa: BLE001 - try the next free model
                    errors.append(str(exc)[:200])
                    log.warning("text model failed: %s", str(exc)[:200])
        if not cheap:
            try:
                return self._worker(system, user, "large")
            except Exception as exc:  # noqa: BLE001
                errors.append(f"workers-ai-large: {exc}")
        raise RuntimeError("all text models failed: " + " | ".join(errors))


def generate_image(worker: WorkerAPI, prompt: str, preferred: str | None = None,
                   flag_keys: list[str] | None = None, building_key: str | None = None,
                   custom_refs: list[dict] | None = None) -> tuple[bytes, str]:
    """Cloudflare Workers AI through the Worker (it chooses the model within the free allowance and
    passes real reference pictures to models that accept them), then Pollinations as a last resort."""
    flag_keys = flag_keys or []
    ref_text, refs = (references.resolve(flag_keys, building_key, custom_refs, worker.base)
                      if (flag_keys or building_key) else ("", []))
    plain_text = references.describe_only(flag_keys, building_key, custom_refs)
    errors = []
    if preferred != "pollinations":
        try:
            return worker.generate_image(f"{prompt} {ref_text}".strip(), f"{prompt} {plain_text}".strip(), refs,
                                         preferred or "auto")
        except Exception as exc:  # noqa: BLE001
            errors.append(f"workers-ai: {exc}")
            log.warning("Cloudflare image models failed: %s", str(exc)[:300])
    try:
        full = f"{prompt} {plain_text}".strip()
        url = ("https://image.pollinations.ai/prompt/" + urllib.parse.quote(full[:1200])
               + "?width=1024&height=1232&nologo=true&model=flux&seed=" + str(int(time.time()) % 100000))
        r = requests.get(url, timeout=180)
        if r.ok and r.headers.get("content-type", "").startswith("image/"):
            return r.content, "pollinations"
        errors.append(f"pollinations: HTTP {r.status_code}")
    except requests.RequestException as exc:
        errors.append(f"pollinations: {exc}")
    raise RuntimeError("all image models failed: " + " | ".join(errors))
