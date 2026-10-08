"""Accurate national flags for news images.

Image models often draw flags wrong. For every flag the writer puts in a scene we add an exact
written description to the prompt and, for FLUX.2 models, pass the real flag image (public domain,
from flagcdn.com) as a reference picture so the design is copied faithfully.
"""
from __future__ import annotations

import base64
import logging

import requests

log = logging.getLogger("flags")

FLAGS = {
    "PK": ("Pakistan", "a dark green field with a vertical white band on the hoist side (one quarter of the width) "
                       "and a white crescent moon with a white five-pointed star in the centre of the green field"),
    "CN": ("China", "a red field with one large yellow five-pointed star and four small yellow stars in an arc in the upper hoist corner"),
    "US": ("the United States", "thirteen horizontal red and white stripes with a blue canton of fifty small white stars in the upper hoist corner"),
    "SA": ("Saudi Arabia", "a green field with white Arabic calligraphy above a horizontal white sword"),
    "AE": ("the United Arab Emirates", "a vertical red band at the hoist and three horizontal stripes of green, white and black"),
    "QA": ("Qatar", "a maroon field with a white serrated band of nine points on the hoist side"),
    "BH": ("Bahrain", "a red field with a white serrated band of five points on the hoist side"),
    "KW": ("Kuwait", "horizontal green, white and red stripes with a black trapezoid on the hoist side"),
    "OM": ("Oman", "a vertical red band at the hoist with a small white emblem, and horizontal white, red and green stripes"),
    "TR": ("Turkey", "a red field with a white crescent and a white five-pointed star left of centre"),
    "IR": ("Iran", "horizontal green, white and red stripes with a red emblem in the centre"),
    "IN": ("India", "horizontal saffron, white and green stripes with a navy-blue 24-spoke wheel in the centre"),
    "BD": ("Bangladesh", "a green field with a large red disc slightly towards the hoist"),
    "GB": ("the United Kingdom", "the Union Jack: a blue field with overlapping red and white upright and diagonal crosses"),
    "JP": ("Japan", "a white field with a red disc in the centre"),
    "RU": ("Russia", "three horizontal stripes of white, blue and red"),
    "DE": ("Germany", "three horizontal stripes of black, red and gold"),
    "FR": ("France", "three vertical stripes of blue, white and red"),
    "IT": ("Italy", "three vertical stripes of green, white and red"),
    "MY": ("Malaysia", "red and white horizontal stripes with a blue canton holding a yellow crescent and a yellow 14-point star"),
    "ID": ("Indonesia", "two horizontal stripes, red above white"),
    "EG": ("Egypt", "horizontal red, white and black stripes with a golden eagle in the centre"),
    "KR": ("South Korea", "a white field with a red and blue circle in the centre and four black trigrams"),
    "CA": ("Canada", "red vertical bands on each side of a white square with a red maple leaf"),
    "AU": ("Australia", "a dark blue field with the Union Jack in the upper hoist corner and white stars"),
    "EU": ("the European Union", "a blue field with a circle of twelve gold five-pointed stars"),
}


def flag_prompt(codes: list[str], with_reference: bool) -> tuple[str, list[str]]:
    """Return (sentence for the prompt, list of codes actually used, in reference order)."""
    used = [c.upper() for c in codes if c and c.upper() in FLAGS][:2]
    parts = []
    for i, code in enumerate(used):
        name, desc = FLAGS[code]
        ref = f", copied exactly from reference image {i} and shown as a real cloth flag" if with_reference else ""
        parts.append(f"The flag of {name} is accurate: {desc}{ref}.")
    return " ".join(parts), used


def flag_images(codes: list[str]) -> list[str]:
    """Base64 PNGs (320px wide, under the 512px model limit) for the given ISO codes."""
    out = []
    for code in codes:
        try:
            r = requests.get(f"https://flagcdn.com/w320/{code.lower()}.png", timeout=20)
            r.raise_for_status()
            out.append(base64.b64encode(r.content).decode())
        except requests.RequestException as exc:
            log.warning("flag %s unavailable: %s", code, exc)
            return []
    return out
