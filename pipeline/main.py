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

from . import prompts, references
from .ai import TextAI, generate_image
from .feeds import Item, fetch_article_text, fetch_feed, is_due, is_similar, resolve_google_news, title_key
from .queue_sheet import SheetQueue, to_item
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


def build_short_caption(data: dict, hashtags: list[str], limit: int = 270) -> str:
    """X allows 280 characters: the headline, the lead sentence if it fits, and three hashtags."""
    head = data["headline"]
    tags = " ".join(hashtags[:3])
    lead = (data.get("paragraphs") or [""])[0].strip()
    text = f"{head}\n\n{lead}\n\n{tags}"
    if len(text) <= limit:
        return text
    room = limit - len(head) - len(tags) - 5
    if room > 40:
        cut = lead[:room].rsplit(" ", 1)[0].rstrip(",;:") + "…"
        return f"{head}\n\n{cut}\n\n{tags}"
    return f"{head}\n\n{tags}"[:limit]


def gather_candidates(cfg: dict, worker: WorkerAPI) -> list[Item]:
    s = cfg["settings"]
    seen = set(cfg.get("seen", []))
    recent_keys = list(cfg.get("recent_title_keys", []))
    max_age = timedelta(hours=float(s.get("max_article_age_hours", 24)))
    now = datetime.now(timezone.utc)
    items, statuses = [], []
    for feed in cfg.get("feeds", []):
        if not feed.get("enabled", 1) or not is_due(feed, now):
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
                      prompts.SELECT_USER.format(count=count + 2, items="\n".join(lines)), cheap=True)
        order = [int(n) - 1 for n in res.get("picks", []) if str(n).isdigit() and 0 < int(n) <= len(pool)]
        log.info("selection: %s (%s)", [n + 1 for n in order], res.get("reason", ""))
        ranked = [pool[i] for i in dict.fromkeys(order)]
        return ranked + [p for p in pool if p not in ranked]
    except Exception as exc:  # noqa: BLE001
        log.warning("selection failed, using newest first: %s", exc)
        return pool


class NotEnoughText(Exception):
    pass


def write_post(ai: TextAI, item: Item, s: dict, custom_refs: list[dict] | None = None) -> dict:
    item.link = resolve_google_news(item.link)
    text = fetch_article_text(item.link)
    if len(text) < 300:
        text = (item.summary + "\n" + text).strip()
    if len(text) < 250:
        # A headline alone is not enough to write an accurate post; skip rather than guess.
        raise NotEnoughText(f"only {len(text)} characters of article text")
    fixed = [t for t in s.get("fixed_hashtags", []) if t]
    system = prompts.WRITE_SYSTEM.format(
        brand=s["brand_name"], niche=s["niche"], language=s.get("language", "English"), tone=s["tone"],
        hashtag_count=s.get("hashtag_count", 9), image_style=s.get("image_style", ""),
        people_rule=prompts.PEOPLE_RULES.get(s.get("people_in_images", "none"), prompts.PEOPLE_RULES["none"]),
        reference_catalogue=references.catalogue(custom_refs),
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


def make_post(item: Item, ctx: dict) -> dict:
    """Write the post, create the image, render the card and hand it to the Worker (which publishes in live mode)."""
    s, ai, worker, cfg = ctx["s"], ctx["ai"], ctx["worker"], ctx["cfg"]
    log.info("writing: %s (%s)", item.title, item.link)
    data = write_post(ai, item, s, cfg.get("custom_refs", []))
    prompt = data["image_prompt"].strip() + " " + prompts.image_suffix(s.get("people_in_images", "none"))
    scene = data.get("scene") or {}
    log.info("scene: %s", scene)
    flag_keys = [str(c) for c in (scene.get("flags") or []) if c][:3]
    building_key = str(scene.get("landmark_key") or "").strip() or None
    bg, image_model = generate_image(worker, prompt, s.get("image_model"), flag_keys, building_key, cfg.get("custom_refs", []))
    if image_model == "pollinations":  # trim the corner watermark
        im = Image.open(io.BytesIO(bg))
        buf = io.BytesIO()
        im.crop((0, 0, im.width, int(im.height * 0.93))).convert("RGB").save(buf, "JPEG", quality=95)
        bg = buf.getvalue()
    card = render_card(
        bg, data["headline"], data["highlights"], brand_name=s["brand_name"], accent_hex=s.get("accent_color"),
        logo_png=ctx["logo"], frame_png=ctx["frame"], footer_icons=s.get("footer_icons"),
        footer_handle=s.get("footer_handle", ""), ai_label=bool(s.get("image_ai_label")),
        enhance={"off": 0.0, "normal": 1.0, "strong": 1.6}.get(s.get("image_enhance", "normal"), 1.0))
    post_id = uuid.uuid4().hex[:12]
    worker.upload_image(post_id, card)
    hashtags = clean_hashtags(data.get("hashtags", []), s.get("fixed_hashtags", []), int(s.get("hashtag_count", 9)))
    res = worker.create_post({
        "id": post_id, "run_id": ctx["run_id"], "mode": ctx["mode"], "source_url": item.link, "source_name": item.source,
        "source_title": item.title, "headline": data["headline"], "highlights": data["highlights"],
        "caption": build_caption(data, item, s, hashtags), "hashtags": hashtags,
        "caption_short": build_short_caption(data, hashtags),
        "image_prompt": prompt, "alt_text": data.get("alt_text", ""), "category": data.get("category", ""),
        "image_model": image_model, "text_model": ai.used[-1] if ai.used else "",
    })
    log.info("post %s -> %s %s", post_id, res.get("status"), res.get("error") or "")
    return res


def collect(ctx: dict, queue: SheetQueue) -> str:
    """Fetch all sources and add the best new stories to the queue sheet."""
    s, worker = ctx["s"], ctx["worker"]
    existing = queue.list(200)
    have_links = {r["link"] for r in existing}
    have_keys = [title_key(r.get("title", "")) for r in existing]
    cands = [c for c in gather_candidates(ctx["cfg"], worker)
             if c.link not in have_links and not is_similar(c.title_key, have_keys)]
    k = max(1, int(s.get("stories_per_collection", 3)))
    picks = select(ctx["ai"], cands, k, s)[:k] if cands else []
    added = queue.append(picks)
    worker.mark_seen([{"guid": i.guid, "title_key": i.title_key} for i in picks])
    pruned = queue.prune(float(s.get("queue_max_age_hours", 24)), int(s.get("queue_max_items", 30)))
    msg = f"queue: +{added} new, -{pruned} old"
    log.info(msg)
    return msg


def queue_order(rows: list[dict], order: str) -> list[dict]:
    if order != "freshest":
        return rows
    return sorted(rows, key=lambda r: r.get("published") or r.get("added") or "", reverse=True)


def publish_from_queue(ctx: dict, queue: SheetQueue, count: int) -> list[dict]:
    """Post the next stories from the queue; posted (or unusable) rows move to the Posted tab."""
    created, attempts = [], 0
    for row in queue_order(queue.list(100), ctx["s"].get("queue_order", "freshest")):
        if len(created) >= count or attempts >= count + 3:
            break
        attempts += 1
        item = to_item(row)
        try:
            res = make_post(item, ctx)
        except NotEnoughText as exc:
            log.info("skipping %s: %s", item.link, exc)
            if ctx["mode"] != "test":
                queue.remove(row["link"], result=f"skipped: {exc}")
            continue
        except Exception as exc:  # noqa: BLE001
            if "all text models failed" in str(exc):
                raise
            log.error("post failed for %s: %s", item.link, exc)
            if ctx["mode"] != "test":
                queue.remove(row["link"], result=f"failed: {str(exc)[:120]}")
            continue
        created.append(res)
        if ctx["mode"] != "test":
            queue.remove(row["link"], result=res.get("status", ""), image=res.get("image_url", ""))
    return created


def main() -> int:
    worker = WorkerAPI(os.environ["WORKER_URL"], os.environ["PIPELINE_SECRET"])
    mode = os.environ.get("MODE", "test").strip() or "test"
    trigger = os.environ.get("TRIGGER", "manual").strip() or "manual"
    article_url = os.environ.get("ARTICLE_URL", "").strip()
    queue_url = os.environ.get("QUEUE_URL", "").strip()
    gh_url = ""
    if os.environ.get("GITHUB_RUN_ID"):
        gh_url = f"{os.environ['GITHUB_SERVER_URL']}/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']}"
    run_id = worker.start_run(os.environ.get("RUN_ID", "").strip() or uuid.uuid4().hex[:12], mode, trigger, gh_url)
    log.info("run %s mode=%s trigger=%s queue=%s", run_id, mode, trigger, bool(queue_url))

    created, status, summary, notes = [], "error", "", []
    try:
        cfg = worker.config()
        s = cfg["settings"]
        ctx = {
            "cfg": cfg, "s": s, "worker": worker, "mode": "test" if mode == "collect" else mode, "run_id": run_id,
            "ai": TextAI(os.environ.get("GEMINI_API_KEY", ""), worker, s.get("text_models") or None),
            "logo": worker.asset("logo.png") if cfg.get("assets", {}).get("logo") else None,
            "frame": worker.asset("frame.png") if cfg.get("assets", {}).get("frame") else None,
        }
        queue = SheetQueue(queue_url) if queue_url else None
        count = 1 if mode == "test" else max(0, min(int(s.get("posts_per_run", 1)), int(cfg.get("remaining_today", 1))))

        if article_url:
            item = single_article(article_url)
            created.append(make_post(item, ctx))
            worker.mark_seen([{"guid": item.guid, "title_key": item.title_key}])
            if queue and mode == "live":
                queue.remove(article_url, result=created[-1].get("status", ""), image=created[-1].get("image_url", ""))
        elif queue:
            notes.append(collect(ctx, queue))
            if mode == "collect":
                status, summary = "success", notes[-1]
                return 0
            if count == 0:
                status, summary = "skipped", f"daily post limit reached; {notes[-1]}"
                return 0
            created = publish_from_queue(ctx, queue, count)
            if not created:
                status, summary = "empty", f"queue has no usable stories; {notes[-1]}"
                return 0
        else:
            if count == 0:
                status, summary = "skipped", "daily post limit reached"
                return 0
            for item in select(ctx["ai"], gather_candidates(cfg, worker), count, s):
                if len(created) >= count:
                    break
                try:
                    created.append(make_post(item, ctx))
                except NotEnoughText as exc:
                    log.info("skipping %s: %s", item.link, exc)
                worker.mark_seen([{"guid": item.guid, "title_key": item.title_key}])
            if not created:
                status, summary = "empty", "no new stories in feeds"
                return 0

        ok = [c for c in created if c.get("status") != "failed"]
        status = "success" if ok else "error"
        summary = f"{len(ok)} post(s): " + ", ".join(c.get("status", "?") for c in created)
        if notes:
            summary += "; " + "; ".join(notes)
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
