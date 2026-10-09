"""Fill the Google Sheet queue from the starter sources without the cloud system.

Picks the freshest stories, alternating between sources, skipping anything already queued or too
similar to a queued headline. Usage: .venv/bin/python scripts/collect_now.py [count]
"""
from __future__ import annotations

import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from pipeline.feeds import fetch_feed, is_similar, title_key  # noqa: E402
from pipeline.queue_sheet import SheetQueue  # noqa: E402


def env_value(key: str) -> str:
    for line in (ROOT / ".env").read_text().splitlines():
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip()
    return ""


def starter_feeds() -> list[dict]:
    sql = (ROOT / "worker" / "seed.sql").read_text()
    return [{"id": i, "url": u, "name": n, "category": c}
            for i, (u, n, c) in enumerate(re.findall(r"\('([^']+)', '([^']+)', '([^']+)'", sql), 1)]


def main() -> None:
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 6
    queue = SheetQueue(env_value("QUEUE_URL"))
    queued = queue.list(200)
    have_links = {r["link"] for r in queued}
    have_keys = [title_key(r["title"]) for r in queued]
    cutoff = datetime.now(timezone.utc) - timedelta(hours=12)

    per_source = []
    for feed in starter_feeds():
        items, err = fetch_feed(feed)
        fresh = sorted([i for i in items if i.published and i.published >= cutoff], key=lambda i: i.published, reverse=True)
        print(f"{feed['name']:26} {len(items):3} items, {len(fresh):3} in last 12h{'  ERROR ' + err if err else ''}")
        per_source.append(fresh)

    picks = []
    while len(picks) < count and any(per_source):
        for bucket in per_source:
            while bucket:
                it = bucket.pop(0)
                if it.link in have_links or is_similar(it.title_key, have_keys + [p.title_key for p in picks]):
                    continue
                picks.append(it)
                break
            if len(picks) >= count:
                break
    added = queue.append(picks)
    print(f"\nAdded {added} stories to the queue:")
    for row in queue.list(50):
        print(f"- [{row['source']}] {row['title']}")


if __name__ == "__main__":
    main()
