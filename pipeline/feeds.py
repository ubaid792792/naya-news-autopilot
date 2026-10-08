"""RSS fetching, de-duplication and article text extraction."""
from __future__ import annotations

import calendar
import difflib
import html
import logging
import re
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


def fetch_feed(feed: dict) -> tuple[list[Item], str | None]:
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
        items.append(Item(guid=(e.get("id") or link)[:500], title=title, link=link, summary=summary,
                          source=source, published=published, feed_id=feed.get("id"),
                          category=feed.get("category", "")))
    return items, None


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
