"""Client for the Cloudflare Worker control plane (config, AI proxy, image hosting, publishing)."""
from __future__ import annotations

import base64
import time

import requests


class WorkerError(RuntimeError):
    pass


class WorkerAPI:
    def __init__(self, base_url: str, secret: str):
        self.base = base_url.rstrip("/")
        self.session = requests.Session()
        self.session.headers["Authorization"] = f"Bearer {secret}"

    def _call(self, method: str, path: str, *, retries: int = 2, timeout: int = 60, **kw):
        last = None
        for attempt in range(retries + 1):
            try:
                r = self.session.request(method, self.base + path, timeout=timeout, **kw)
                if r.status_code >= 500 and attempt < retries:
                    time.sleep(3 * (attempt + 1))
                    continue
                if not r.ok:
                    raise WorkerError(f"{method} {path} -> {r.status_code}: {r.text[:300]}")
                return r.json() if r.content else {}
            except requests.RequestException as exc:
                last = exc
                time.sleep(3 * (attempt + 1))
        raise WorkerError(f"{method} {path} failed: {last}")

    def config(self) -> dict:
        return self._call("GET", "/pipeline/config")

    def start_run(self, run_id: str, mode: str, trigger: str, gh_run_url: str) -> str:
        res = self._call("POST", "/pipeline/runs", json={
            "id": run_id, "mode": mode, "trigger": trigger, "gh_run_url": gh_run_url})
        return res["id"]

    def finish_run(self, run_id: str, status: str, summary: str, log: str) -> None:
        self._call("PATCH", f"/pipeline/runs/{run_id}", json={
            "status": status, "summary": summary, "log": log[-20000:]})

    def generate_image(self, prompt: str, width: int, height: int, model: str,
                       references: list[str] | None = None) -> bytes:
        res = self._call("POST", "/pipeline/ai/image", timeout=150, retries=1, json={
            "prompt": prompt, "width": width, "height": height, "model": model,
            "references": references or []})
        if not res.get("image"):
            raise WorkerError(f"image model returned no image: {str(res)[:200]}")
        return base64.b64decode(res["image"])

    def llm(self, system: str, user: str, size: str = "large") -> str:
        res = self._call("POST", "/pipeline/ai/text", timeout=150, retries=1, json={
            "system": system, "user": user, "size": size})
        return res.get("text", "")

    def upload_image(self, post_id: str, jpeg: bytes) -> str:
        res = self._call("PUT", f"/pipeline/images/{post_id}", data=jpeg,
                         headers={"Content-Type": "image/jpeg"}, timeout=90)
        return res["url"]

    def create_post(self, post: dict) -> dict:
        return self._call("POST", "/pipeline/posts", json=post, timeout=90, retries=0)

    def mark_seen(self, items: list[dict]) -> None:
        if items:
            self._call("POST", "/pipeline/seen", json={"items": items})

    def update_feeds(self, results: list[dict]) -> None:
        if results:
            self._call("POST", "/pipeline/feed-status", json={"results": results})

    def asset(self, name: str) -> bytes | None:
        r = self.session.get(f"{self.base}/asset/{name}", timeout=30)
        return r.content if r.ok and r.content else None
