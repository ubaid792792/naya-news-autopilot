"""RSS fetching, de-duplication and article text extraction."""
from __future__ import annotations

import calendar
import difflib
import html
import json
import logging
import re
from urllib.parse import quote
from dataclasses import dataclass, field
from datetime import datetime, timezone

import feedparser
import requests
from bs4 import BeautifulSoup

log = logging.getLogger("feeds")

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0 Safari/537.36")
BOILERPLATE = re.compile(r"cookie|subscribe|get the latest|follow us|google news|whatsapp channel|"
                         r"click here|all rights reserved|copyrighted|may not be published|stories in google search", re.I)
STOPWORDS = set("a an the of in on at to for and or but with from by as is are was were be after over".split())


@dataclass
class Item:
    guid: str
    title: str
    link: str
    summary: str
    source: str
    published: datetime | None
    feed_id: int | None = None
    category: str = ""
    title_key: str = field(init=False)

    def __post_init__(self):
        self.title_key = title_key(self.title)


def clean_text(value: str) -> str:
    text = BeautifulSoup(html.unescape(value or ""), "lxml").get_text(" ")
    return re.sub(r"\s+", " ", text).strip()


def title_key(title: str) -> str:
    words = re.findall(r"[a-z0-9]+", (title or "").lower())
    return " ".join(w for w in words if w not in STOPWORDS)


def is_similar(key: str, others: list[str], threshold: float = 0.72) -> bool:
    words = set(key.split())
    for other in others:
        if not other:
            continue
        if difflib.SequenceMatcher(None, key, other).ratio() >= threshold:
            return True
        other_words = set(other.split())
        if words and other_words and len(words & other_words) / len(words | other_words) >= 0.6:
            return True
    return False


def is_due(feed: dict, now: datetime) -> bool:
    """A source with its own check interval is skipped until that interval has passed."""
    minutes = int(feed.get("interval_minutes") or 0)
    last = feed.get("last_fetched_at")
    if minutes <= 0 or not last:
        return True
    try:
        last_dt = datetime.fromisoformat(last.replace("Z", "+00:00"))
    except ValueError:
        return True
    return (now - last_dt).total_seconds() >= minutes * 60 - 120


def fetch_telegram(feed: dict) -> tuple[list[Item], str | None]:
    """Public Telegram channels have a free web preview at t.me/s/<channel>."""
    try:
        r = requests.get(feed["url"], timeout=25, headers={"User-Agent": UA})
        r.raise_for_status()
    except requests.RequestException as exc:
        return [], str(exc)[:200]
    soup = BeautifulSoup(r.text, "lxml")
    channel = feed["url"].rstrip("/").split("/")[-1]
    source = feed.get("name") or f"Telegram: {channel}"
    items = []
    for msg in soup.select("div.tgme_widget_message[data-post]")[-30:]:
        body = msg.select_one("div.tgme_widget_message_text")
        if not body:
            continue
        text = re.sub(r"\s+", " ", body.get_text(" ")).strip()
        if len(text) < 60:
            continue
        stamp = msg.select_one("time[datetime]")
        published = None
        if stamp:
            try:
                published = datetime.fromisoformat(stamp["datetime"]).astimezone(timezone.utc)
            except ValueError:
                pass
        outbound = next((a["href"] for a in body.select("a[href^=http]") if "t.me/" not in a["href"]), None)
        post = msg["data-post"]
        title = re.split(r"(?<=[.!?])\s", text, maxsplit=1)[0][:160]
        items.append(Item(guid=f"tg:{post}", title=title, link=outbound or f"https://t.me/{post}",
                          summary=text[:1500], source=source, published=published,
                          feed_id=feed.get("id"), category=feed.get("category", "")))
    return items, None


def fetch_feed(feed: dict) -> tuple[list[Item], str | None]:
    if feed.get("kind") == "telegram" or feed["url"].startswith("https://t.me/s/"):
        return fetch_telegram(feed)
    try:
        r = requests.get(feed["url"], timeout=25, headers={"User-Agent": UA, "Accept": "application/rss+xml, application/xml, */*"})
        r.raise_for_status()
        parsed = feedparser.parse(r.content)
    except Exception as exc:  # noqa: BLE001
        return [], str(exc)[:200]
    if parsed.bozo and not parsed.entries:
        return [], f"invalid feed: {parsed.bozo_exception}"[:200]
    source = feed.get("name") or clean_text(parsed.feed.get("title", "")) or feed["url"]
    items = []
    for e in parsed.entries[:40]:
        link = e.get("link", "")
        title = clean_text(e.get("title", ""))
        if not title or not link:
            continue
        stamp = e.get("published_parsed") or e.get("updated_parsed")
        published = datetime.fromtimestamp(calendar.timegm(stamp), tz=timezone.utc) if stamp else None
        summary = clean_text(e.get("summary", "") or e.get("description", ""))[:1200]
        item_source = source
        if "news.google.com" in link:
            # Google News titles end with " - Outlet"; the outlet is the real source.
            outlet = (e.get("source") or {}).get("title") or ""
            if outlet:
                item_source = outlet
                title = re.sub(rf"\s+-\s+{re.escape(outlet)}$", "", title)
        items.append(Item(guid=(e.get("id") or link)[:500], title=title, link=link, summary=summary,
                          source=item_source, published=published, feed_id=feed.get("id"),
                          category=feed.get("category", "")))
    return items, None


def resolve_google_news(url: str) -> str:
    """Turn a news.google.com/rss/articles/... link into the publisher's article URL."""
    if "news.google.com" not in url or "/articles/" not in url:
        return url
    try:
        gid = url.split("/articles/")[1].split("?")[0]
        page = requests.get(f"https://news.google.com/rss/articles/{gid}", timeout=20, headers={"User-Agent": UA}).text
        sig = re.search(r'data-n-a-sg="([^"]+)"', page)
        ts = re.search(r'data-n-a-ts="([^"]+)"', page)
        if not (sig and ts):
            return url
        req = [[["Fbv4je", json.dumps(["garturlreq", [["X", "X", ["X", "X"], None, None, 1, 1, "US:en", None, 1, None, None,
                 None, None, None, 0, 1], "X", "X", 1, [1, 1, 1], 1, 1, None, 0, 0, None, 0], gid, int(ts.group(1)),
                 sig.group(1)]), None, "generic"]]]
        r = requests.post("https://news.google.com/_/DotsSplashUi/data/batchexecute", timeout=20,
                          headers={"User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"},
                          data="f.req=" + quote(json.dumps(req)))
        part = r.text.split("\n\n")[1]
        return json.loads(json.loads(part)[0][2])[1]
    except Exception as exc:  # noqa: BLE001
        log.info("google news link not decoded: %s", exc)
        return url


def fetch_article_text(url: str, limit: int = 6000) -> str:
    try:
        r = requests.get(url, timeout=25, headers={"User-Agent": UA})
        r.raise_for_status()
    except requests.RequestException as exc:
        log.info("article fetch failed (%s): %s", url, exc)
        return ""
    soup = BeautifulSoup(r.text, "lxml")
    for tag in soup(["script", "style", "nav", "header", "footer", "aside", "form", "figure", "noscript"]):
        tag.decompose()
    # The story body is the element whose own <p> children hold the most text; this skips
    # author bios and "related stories" blocks that sit in separate containers.
    best, best_len = None, 0
    for el in soup.find_all(["article", "div", "section", "main"]):
        own = [p.get_text(" ", strip=True) for p in el.find_all("p", recursive=False)]
        size = sum(len(t) for t in own if len(t) > 40)
        if size > best_len:
            best, best_len = el, size
    root = best if best_len > 300 else (soup.find("article") or soup.body or soup)
    paras = [re.sub(r"\s+", " ", p.get_text(" ")).strip() for p in root.find_all("p", recursive=root is not best)]
    paras = [p for p in paras if len(p) > 60 and not BOILERPLATE.search(p)]
    text = "\n".join(paras)
    if len(text) < 200:
        meta = soup.find("meta", attrs={"property": "og:description"}) or soup.find("meta", attrs={"name": "description"})
        if meta and meta.get("content"):
            text = (meta["content"] + "\n" + text).strip()
    return text[:limit]
