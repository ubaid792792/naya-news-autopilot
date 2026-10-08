"""One pipeline run: RSS -> pick stories -> write post -> AI image -> news card -> hand to Worker.

Started by GitHub Actions (dispatched by the Worker scheduler or the dashboard).
Environment: WORKER_URL, PIPELINE_SECRET, GEMINI_API_KEY, MODE (live|test), RUN_ID, TRIGGER, ARTICLE_URL.
"""
from __future__ import annotations

import io
import logging
import os
import re
import sys
import uuid
from datetime import datetime, timedelta, timezone

from PIL import Image

from . import prompts
from .ai import TextAI, generate_image
from .feeds import Item, fetch_article_text, fetch_feed, is_similar
from .render import render_card
from .worker_api import WorkerAPI

LOG_BUFFER = io.StringIO()
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s",
                    handlers=[logging.StreamHandler(sys.stdout), logging.StreamHandler(LOG_BUFFER)])
log = logging.getLogger("pipeline")


def clean_hashtags(tags: list[str], fixed: list[str], count: int) -> list[str]:
    out, seen = [], set()
    for tag in list(fixed) + list(tags or []):
        word = re.sub(r"[^\w]", "", str(tag).lstrip("#"))
        if word and word.lower() not in seen:
            seen.add(word.lower())
            out.append("#" + word)
    return out[: max(count, len(fixed))]


def build_caption(data: dict, item: Item, s: dict, hashtags: list[str]) -> str:
    blocks = [p.strip() for p in data.get("paragraphs", []) if str(p).strip()]
    credit = s.get("source_credit", "none")
    if credit == "name":
        blocks.append(f"Source: {item.source}")
    elif credit == "link":
        blocks.append(f"Source: {item.source}\n{item.link}")
    if s.get("disclaimer"):
        blocks.append(s["disclaimer"].strip())
    if hashtags:
        blocks.append(" ".join(hashtags))
    return "\n\n".join(blocks)


def gather_candidates(cfg: dict, worker: WorkerAPI) -> list[Item]:
    s = cfg["settings"]
    seen = set(cfg.get("seen", []))
    recent_keys = list(cfg.get("recent_title_keys", []))
    max_age = timedelta(hours=float(s.get("max_article_age_hours", 24)))
    now = datetime.now(timezone.utc)
    items, statuses = [], []
    for feed in cfg.get("feeds", []):
        if not feed.get("enabled", 1):
            continue
        got, err = fetch_feed(feed)
        statuses.append({"id": feed["id"], "error": err, "count": len(got)})
        log.info("feed %s: %d items%s", feed.get("name") or feed["url"], len(got), f" (error: {err})" if err else "")
        items.extend(got)
    try:
        worker.update_feeds(statuses)
    except Exception as exc:  # noqa: BLE001
        log.warning("feed status update failed: %s", exc)

    fresh = [i for i in items if i.guid not in seen and (i.published is None or now - i.published <= max_age)]
    fresh.sort(key=lambda i: i.published or (now - max_age), reverse=True)
    picked: list[Item] = []
    for it in fresh:
        if is_similar(it.title_key, recent_keys) or is_similar(it.title_key, [p.title_key for p in picked]):
            continue
        picked.append(it)
    log.info("%d fetched, %d unseen and fresh, %d after duplicate filter", len(items), len(fresh), len(picked))
    return picked


def select(ai: TextAI, cands: list[Item], count: int, s: dict) -> list[Item]:
    pool = cands[:25]
    if len(pool) <= count:
        return pool
    lines = []
    for n, it in enumerate(pool, 1):
        when = it.published.strftime("%Y-%m-%d %H:%M UTC") if it.published else "unknown time"
        lines.append(f"{n}. [{it.source}, {when}] {it.title} — {it.summary[:220]}")
    try:
        res = ai.json(prompts.SELECT_SYSTEM.format(brand=s["brand_name"], niche=s["niche"]),
                      prompts.SELECT_USER.format(count=count + 2, items="\n".join(lines)))
        order = [int(n) - 1 for n in res.get("picks", []) if str(n).isdigit() and 0 < int(n) <= len(pool)]
        log.info("selection: %s (%s)", [n + 1 for n in order], res.get("reason", ""))
        ranked = [pool[i] for i in dict.fromkeys(order)]
        return ranked + [p for p in pool if p not in ranked]
    except Exception as exc:  # noqa: BLE001
        log.warning("selection failed, using newest first: %s", exc)
        return pool


def write_post(ai: TextAI, item: Item, s: dict) -> dict:
    text = fetch_article_text(item.link)
    if len(text) < 300:
        text = (item.summary + "\n" + text).strip()
    fixed = [t for t in s.get("fixed_hashtags", []) if t]
    system = prompts.WRITE_SYSTEM.format(
        brand=s["brand_name"], niche=s["niche"], language=s.get("language", "English"), tone=s["tone"],
        hashtag_count=s.get("hashtag_count", 9), image_style=s.get("image_style", ""),
        fixed_tags=(" Always include: " + " ".join(fixed) + ".") if fixed else "")
    user = prompts.WRITE_USER.format(
        source=item.source, title=item.title, link=item.link,
        published=item.published.isoformat() if item.published else "unknown", text=text or item.title)
    data = ai.json(system, user)
    for key in ("headline", "paragraphs", "image_prompt"):
        if not data.get(key):
            raise ValueError(f"model output missing {key}")
    if isinstance(data["paragraphs"], str):
        data["paragraphs"] = [p for p in data["paragraphs"].split("\n") if p.strip()]
    headline = re.sub(r"\s+", " ", str(data["headline"])).strip().strip('."')
    data["headline"] = headline
    data["highlights"] = [h for h in data.get("highlights", [])[:2] if str(h).lower() in headline.lower()]
    return data


def single_article(url: str) -> Item:
    import requests
    from bs4 import BeautifulSoup
    from .feeds import UA
    r = requests.get(url, timeout=25, headers={"User-Agent": UA})
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "lxml")
    meta = soup.find("meta", attrs={"property": "og:title"})
    title = (meta.get("content") if meta else None) or (soup.title.string if soup.title else url)
    site = soup.find("meta", attrs={"property": "og:site_name"})
    desc = soup.find("meta", attrs={"property": "og:description"})
    return Item(guid=url, title=title.strip(), link=url, summary=(desc.get("content") if desc else "") or "",
                source=(site.get("content") if site else "") or re.sub(r"^www\.", "", url.split("/")[2]),
                published=datetime.now(timezone.utc))


def main() -> int:
    worker = WorkerAPI(os.environ["WORKER_URL"], os.environ["PIPELINE_SECRET"])
    mode = os.environ.get("MODE", "test").strip() or "test"
    trigger = os.environ.get("TRIGGER", "manual").strip() or "manual"
    article_url = os.environ.get("ARTICLE_URL", "").strip()
    gh_url = ""
    if os.environ.get("GITHUB_RUN_ID"):
        gh_url = f"{os.environ['GITHUB_SERVER_URL']}/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']}"
    run_id = worker.start_run(os.environ.get("RUN_ID", "").strip() or uuid.uuid4().hex[:12], mode, trigger, gh_url)
    log.info("run %s mode=%s trigger=%s", run_id, mode, trigger)

    created, status, summary = [], "error", ""
    try:
        cfg = worker.config()
        s = cfg["settings"]
        ai = TextAI(os.environ.get("GEMINI_API_KEY", ""), worker, s.get("text_models") or None)
        count = 1 if mode == "test" else max(0, min(int(s.get("posts_per_run", 1)), int(cfg.get("remaining_today", 1))))
        if article_url:
            ordered, count = [single_article(article_url)], 1
        elif count == 0:
            status, summary = "skipped", "daily post limit reached"
            return 0
        else:
            ordered = select(ai, gather_candidates(cfg, worker), count, s)
        if not ordered:
            status, summary = "empty", "no new stories in feeds"
            return 0

        logo = worker.asset("logo.png") if cfg.get("assets", {}).get("logo") else None
        frame = worker.asset("frame.png") if cfg.get("assets", {}).get("frame") else None
        seen_items, attempts = [], 0
        for item in ordered:
            if len(created) >= count or attempts >= count + 2:
                break
            attempts += 1
            log.info("writing: %s (%s)", item.title, item.link)
            try:
                data = write_post(ai, item, s)
            except Exception as exc:  # noqa: BLE001
                log.error("write failed: %s", exc)
                if "all text models failed" in str(exc):
                    break
                seen_items.append({"guid": item.guid, "title_key": item.title_key})
                continue
            prompt = data["image_prompt"].strip() + " Photorealistic editorial photo, no people, no text."
            bg, image_model = generate_image(worker, prompt, s.get("image_model"))
            if image_model == "pollinations":  # trim the corner watermark
                im = Image.open(io.BytesIO(bg))
                buf = io.BytesIO()
                im.crop((0, 0, im.width, int(im.height * 0.93))).convert("RGB").save(buf, "JPEG", quality=95)
                bg = buf.getvalue()
            card = render_card(
                bg, data["headline"], data["highlights"], brand_name=s["brand_name"], accent_hex=s.get("accent_color"),
                logo_png=logo, frame_png=frame, footer_icons=s.get("footer_icons"),
                footer_handle=s.get("footer_handle", ""), ai_label=bool(s.get("image_ai_label")))
            post_id = uuid.uuid4().hex[:12]
            worker.upload_image(post_id, card)
            hashtags = clean_hashtags(data.get("hashtags", []), s.get("fixed_hashtags", []), int(s.get("hashtag_count", 9)))
            res = worker.create_post({
                "id": post_id, "run_id": run_id, "mode": mode, "source_url": item.link, "source_name": item.source,
                "source_title": item.title, "headline": data["headline"], "highlights": data["highlights"],
                "caption": build_caption(data, item, s, hashtags), "hashtags": hashtags,
                "image_prompt": prompt, "alt_text": data.get("alt_text", ""), "category": data.get("category", ""),
                "image_model": image_model, "text_model": ai.used[-1] if ai.used else "",
            })
            log.info("post %s -> %s %s", post_id, res.get("status"), res.get("error") or "")
            created.append(res)
            seen_items.append({"guid": item.guid, "title_key": item.title_key})
        worker.mark_seen(seen_items)
        ok = [c for c in created if c.get("status") != "failed"]
        status = "success" if ok else "error"
        summary = f"{len(ok)} post(s): " + ", ".join(c.get("status", "?") for c in created) if created else "nothing created"
        return 0 if ok else 1
    except Exception as exc:  # noqa: BLE001
        log.exception("run failed")
        summary = f"failed: {exc}"[:300]
        return 1
    finally:
        try:
            worker.finish_run(run_id, status, summary, LOG_BUFFER.getvalue())
        except Exception as exc:  # noqa: BLE001
            log.error("could not report run result: %s", exc)


if __name__ == "__main__":
    sys.exit(main())
