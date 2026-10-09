"""Client for the Google Sheet queue (Apps Script web app, see apps-script/Code.gs)."""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone

import requests

from .feeds import Item

log = logging.getLogger("queue")


class SheetQueue:
    def __init__(self, url: str):
        self.url = url

    def _post(self, payload: dict, expect: str | None = None) -> dict:
        last = None
        for attempt in range(3):
            try:
                # Apps Script answers a POST with a redirect to the result; requests follows it.
                r = requests.post(self.url, json=payload, timeout=60)
                r.raise_for_status()
                data = r.json()
                if not data.get("ok"):
                    raise RuntimeError(data.get("error") or "queue error")
                if expect and expect not in data:
                    raise RuntimeError(f"unexpected reply: {str(data)[:120]}")
                return data
            except (requests.RequestException, ValueError, RuntimeError) as exc:
                last = exc
                time.sleep(3 * (attempt + 1))
        raise RuntimeError(f"queue sheet unavailable: {last}")

    def list(self, limit: int = 50) -> list[dict]:
        return self._post({"action": "list", "limit": limit}, "items")["items"]

    def append(self, items: list[Item]) -> int:
        payload = [{"title": i.title, "source": i.source, "link": i.link, "category": i.category,
                    "summary": i.summary, "published": i.published.isoformat() if i.published else ""} for i in items]
        return self._post({"action": "append", "items": payload}, "added")["added"] if payload else 0

    def remove(self, link: str, result: str = "", image: str = "", title: str = "", source: str = "") -> int:
        return self._post({"action": "remove", "link": link, "result": result, "image": image,
                           "title": title, "source": source}, "removed")["removed"]

    def prune(self, max_age_hours: float, max_items: int) -> int:
        return self._post({"action": "prune", "max_age_hours": max_age_hours, "max_items": max_items}, "removed")["removed"]


def to_item(row: dict) -> Item:
    published = None
    for key in ("published", "added"):
        if row.get(key):
            try:
                published = datetime.fromisoformat(row[key].replace("Z", "+00:00")).astimezone(timezone.utc)
                break
            except ValueError:
                pass
    return Item(guid=row["link"], title=row.get("title") or row["link"], link=row["link"],
                summary=row.get("summary", ""), source=row.get("source") or "", published=published,
                category=row.get("category", ""))
