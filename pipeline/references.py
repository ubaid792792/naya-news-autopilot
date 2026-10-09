"""Reference pictures that keep flags, emblems and official buildings accurate in AI images.

Three sources, looked up by key:
- country flags by ISO code (PK, CN, US ...) from flagcdn.com, with exact written designs in flags.py;
- the built-in library in assets/references (organisation and party flags, emblems, official buildings);
- custom references uploaded in the control panel (served by the Worker).
FLUX.2 [klein] accepts up to 4 reference images, each under 512x512 px.
"""
from __future__ import annotations

import base64
import io
import json
import logging
from pathlib import Path

import requests
from PIL import Image

from .flags import FLAGS

log = logging.getLogger("references")

LIB_DIR = Path(__file__).resolve().parent.parent / "assets" / "references"
LIBRARY: dict = json.loads((LIB_DIR / "index.json").read_text())
MAX_REFS = 4


def catalogue(custom: list[dict] | None = None) -> str:
    """Lines listing the keys the writer may use, grouped by kind."""
    entries = {k: v for k, v in LIBRARY.items()}
    for c in custom or []:
        entries[c["key"]] = {"kind": c.get("kind", "flag"), "name": c.get("name", c["key"])}
    flags = [f"{k} ({v['name']})" for k, v in entries.items() if v["kind"] != "building"]
    buildings = [f"{k} ({v['name']})" for k, v in entries.items() if v["kind"] == "building"]
    return ("Flag and emblem keys: any ISO country code (PK, CN, US, SA, AE, GB, TR, IR, IN ...), "
            + ", ".join(flags) + ".\nBuilding keys: " + ", ".join(buildings) + ".")


def _small_png(raw: bytes) -> str:
    im = Image.open(io.BytesIO(raw))
    im = im.convert("RGBA")
    bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
    bg.alpha_composite(im)
    im = bg.convert("RGB")
    im.thumbnail((500, 500))
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode()


def _load(key: str, custom: dict, asset_url: str | None) -> tuple[str, str, str] | None:
    """Return (kind, sentence-without-index, base64 png) for one key, or None."""
    up = key.upper()
    if up in FLAGS:
        name, desc = FLAGS[up]
        try:
            r = requests.get(f"https://flagcdn.com/w320/{up.lower()}.png", timeout=20)
            r.raise_for_status()
            return "flag", f"The flag of {name} is accurate: {desc}", _small_png(r.content)
        except requests.RequestException as exc:
            log.warning("flag %s unavailable: %s", up, exc)
            return None
    entry = LIBRARY.get(key) or LIBRARY.get(up) or LIBRARY.get(key.lower())
    if entry:
        raw = (LIB_DIR / entry["file"]).read_bytes()
        return entry["kind"], _sentence(entry), _small_png(raw)
    c = custom.get(key) or custom.get(up)
    if c and asset_url:
        try:
            r = requests.get(f"{asset_url}/asset/ref/{c['key']}", timeout=20)
            r.raise_for_status()
            return c.get("kind", "flag"), _sentence(c), _small_png(r.content)
        except requests.RequestException as exc:
            log.warning("custom reference %s unavailable: %s", key, exc)
    return None


def _sentence(entry: dict) -> str:
    desc = f": {entry['desc']}" if entry.get("desc") else ""
    if entry.get("kind") == "building":
        return (f"The {entry['name']} is shown accurately{desc}, with the same architecture, shape, materials "
                f"and colours as the real building")
    return f"The {entry.get('kind', 'flag')} of {entry['name']} is accurate{desc}"


def resolve(flag_keys: list[str], building_key: str | None, custom: list[dict] | None = None,
            asset_url: str | None = None) -> tuple[str, list[str]]:
    """Build the prompt sentences and the reference images (base64 PNG) for a scene.

    A building photo and flag pictures together confuse the 4B model (flags come out wrong), so
    when the scene has an official building only its photo is used and flags are left out."""
    custom_map = {c["key"]: c for c in custom or []}
    if building_key and _load_kind(building_key, custom_map) == "building":
        text, refs = _resolve_keys([building_key], custom_map, asset_url)
        if refs:
            return text + " No flags in the scene.", refs
    return _resolve_keys([k for k in flag_keys if k], custom_map, asset_url)


def _load_kind(key: str, custom_map: dict) -> str | None:
    entry = LIBRARY.get(key) or LIBRARY.get(key.upper()) or LIBRARY.get(key.lower()) or custom_map.get(key.upper())
    return entry.get("kind") if entry else None


def _resolve_keys(keys: list[str], custom_map: dict, asset_url: str | None) -> tuple[str, list[str]]:
    sentences, refs, seen = [], [], set()
    for key in keys:
        if key in seen or len(refs) >= MAX_REFS:
            continue
        seen.add(key)
        got = _load(key, custom_map, asset_url)
        if not got:
            continue
        kind, sentence, b64 = got
        tail = ("matching reference image {i}" if kind == "building"
                else "copied exactly from reference image {i} and shown as a real cloth flag or printed emblem in the scene")
        sentences.append(f"{sentence}, {tail.format(i=len(refs))}.")
        refs.append(b64)
    return " ".join(sentences), refs


def describe_only(flag_keys: list[str], building_key: str | None, custom: list[dict] | None = None) -> str:
    """Text-only version for image models that cannot take reference pictures."""
    custom_map = {c["key"]: c for c in custom or []}
    out = []
    for key in ([building_key] if building_key else []) + list(flag_keys):
        if not key:
            continue
        if key.upper() in FLAGS:
            name, desc = FLAGS[key.upper()]
            out.append(f"The flag of {name} is accurate: {desc}.")
        elif (entry := LIBRARY.get(key) or LIBRARY.get(key.upper()) or custom_map.get(key)):
            out.append(_sentence(entry) + ".")
    return " ".join(out)
