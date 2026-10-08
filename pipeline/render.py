"""Compose the final news card in the Startup Pakistan layout.

Layers, bottom to top: AI background (cover-fit), top and bottom dark gradients,
brand logo (top-left), headline with highlighted key phrases (bottom, centred),
social icon footer, optional transparent PNG frame overlay.
"""
from __future__ import annotations

import io
import re
from dataclasses import dataclass
from pathlib import Path

import math

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps, ImageStat

ASSETS = Path(__file__).resolve().parent.parent / "assets"
FONTS = ASSETS / "fonts"

W, H = 1080, 1300
SIDE_MARGIN = 60
FOOTER_Y = H - 62
HEADLINE_BOTTOM = H - 150

ICON_GLYPHS = {
    "facebook": ("brands", ""),
    "instagram": ("brands", ""),
    "x": ("brands", ""),
    "linkedin": ("brands", ""),
    "youtube": ("brands", ""),
    "tiktok": ("brands", ""),
    "threads": ("brands", ""),
    "web": ("solid", ""),
}


def _font(name: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONTS / name), size)


def hex_to_rgb(value: str, default=(255, 199, 44)) -> tuple[int, int, int]:
    value = (value or "").strip().lstrip("#")
    if re.fullmatch(r"[0-9a-fA-F]{6}", value):
        return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))
    return default


def cover_fit(img: Image.Image, width: int = W, height: int = H) -> Image.Image:
    img = img.convert("RGB")
    scale = max(width / img.width, height / img.height)
    resized = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
    left = (resized.width - width) // 2
    # Bias the crop upward a little: the subject usually sits above the headline area.
    top = max(0, min(resized.height - height, int((resized.height - height) * 0.35)))
    return resized.crop((left, top, left + width, top + height))


def enhance_photo(img: Image.Image, strength: float = 1.0) -> Image.Image:
    """Make the AI picture bright and vibrant: gentle auto-levels, midtone lift for dark images,
    extra colour saturation, a touch of contrast and sharpening."""
    if strength <= 0:
        return img
    img = ImageOps.autocontrast(img.convert("RGB"), cutoff=0.4, preserve_tone=True)
    lum = ImageStat.Stat(img.convert("L")).mean[0] / 255
    target = 0.50
    if 0.02 < lum < target:
        gamma = max(0.62, min(1.0, math.log(target) / math.log(lum)))
        gamma = 1 - (1 - gamma) * min(1.0, strength)
        lut = [round(255 * ((i / 255) ** gamma)) for i in range(256)]
        img = img.point(lut * 3)
    img = ImageEnhance.Color(img).enhance(1 + 0.25 * strength)
    img = ImageEnhance.Contrast(img).enhance(1 + 0.06 * strength)
    return img.filter(ImageFilter.UnsharpMask(radius=2, percent=int(55 * strength), threshold=3))


def _gradient_layer(start_y: int, end_y: int, max_alpha: int, top_down: bool) -> Image.Image:
    """Black layer whose alpha ramps (ease-in) from 0 to max_alpha between start_y and end_y."""
    mask = Image.new("L", (1, H), 0)
    span = max(1, end_y - start_y)
    for y in range(H):
        if top_down:
            t = 1.0 if y <= start_y else max(0.0, 1 - (y - start_y) / span)
        else:
            t = 0.0 if y <= start_y else min(1.0, (y - start_y) / span)
        mask.putpixel((0, y), int(max_alpha * (t ** 1.6)))
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    layer.putalpha(mask.resize((W, H)))
    return layer


def default_logo(brand_name: str, accent: tuple[int, int, int]) -> Image.Image:
    """Wordmark used until a custom logo PNG is uploaded: accent tile + stacked brand name."""
    words = (brand_name or "News").upper().split()[:3]
    tile = 92
    name_font = _font("Poppins-Bold.ttf", 30)
    line_h = 34
    text_w = max(int(name_font.getlength(w)) for w in words)
    width = max(tile, text_w) + 8
    height = tile + 12 + line_h * len(words)
    logo = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    d = ImageDraw.Draw(logo)
    d.rounded_rectangle((0, 0, tile, tile), radius=22, fill=accent + (255,))
    letter_font = _font("Poppins-ExtraBold.ttf", 64)
    letter = words[0][0]
    bbox = d.textbbox((0, 0), letter, font=letter_font)
    d.text(((tile - (bbox[2] - bbox[0])) / 2 - bbox[0], (tile - (bbox[3] - bbox[1])) / 2 - bbox[1]),
           letter, font=letter_font, fill=(17, 17, 17))
    y = tile + 8
    for w in words:
        d.text((0, y), w, font=name_font, fill=(255, 255, 255))
        y += line_h
    return logo


@dataclass
class Token:
    text: str
    highlight: bool


def _tokenize(headline: str, highlights: list[str]) -> list[Token]:
    """Split into words; each highlighted phrase becomes one unbreakable token so its box never splits."""
    words = headline.split()
    group = [-1] * len(words)
    norm = [re.sub(r"[^\w%₨$]", "", w).lower() for w in words]
    for gi, phrase in enumerate(highlights or []):
        target = [t for t in (re.sub(r"[^\w%₨$]", "", w).lower() for w in phrase.split()) if t]
        if not target:
            continue
        for i in range(len(words) - len(target) + 1):
            if norm[i:i + len(target)] == target and all(g == -1 for g in group[i:i + len(target)]):
                for k in range(i, i + len(target)):
                    group[k] = gi
                break
    tokens: list[Token] = []
    i = 0
    while i < len(words):
        if group[i] >= 0:
            j = i
            while j + 1 < len(words) and group[j + 1] == group[i]:
                j += 1
            tokens.append(Token(" ".join(words[i:j + 1]), True))
            i = j + 1
        else:
            tokens.append(Token(words[i], False))
            i += 1
    return tokens


def _wrap(tokens: list[Token], font: ImageFont.FreeTypeFont, max_width: int) -> list[list[Token]]:
    space = font.getlength(" ")
    lines: list[list[Token]] = [[]]
    width = 0.0
    for tok in tokens:
        w = font.getlength(tok.text)
        extra = w if not lines[-1] else space + w
        if lines[-1] and width + extra > max_width:
            lines.append([tok])
            width = w
        else:
            lines[-1].append(tok)
            width += extra
    return lines


def _fit_headline(tokens: list[Token], max_width: int) -> tuple[ImageFont.FreeTypeFont, list[list[Token]]]:
    for size in range(78, 44, -2):
        font = _font("Poppins-ExtraBold.ttf", size)
        lines = _wrap(tokens, font, max_width)
        too_wide = any(font.getlength(" ".join(t.text for t in line)) > max_width for line in lines)
        if len(lines) <= 3 and not too_wide:
            return font, lines
    font = _font("Poppins-ExtraBold.ttf", 46)
    return font, _wrap(tokens, font, max_width)[:5]


def _draw_headline(canvas: Image.Image, headline: str, highlights: list[str], accent) -> int:
    tokens = _tokenize(headline, highlights)
    font, lines = _fit_headline(tokens, W - 2 * SIDE_MARGIN - 20)
    size = font.size
    line_h = int(size * 1.22)
    pad_x, pad_top, pad_bottom = int(size * 0.14), int(size * 0.02), int(size * 0.10)
    ascent_box = font.getbbox("HÅgy")
    cap_top, desc_bottom = ascent_box[1], ascent_box[3]
    total_h = line_h * len(lines)
    y0 = HEADLINE_BOTTOM - total_h

    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    space = font.getlength(" ")
    for li, line in enumerate(lines):
        line_w = sum(font.getlength(t.text) for t in line) + space * (len(line) - 1)
        x = (W - line_w) / 2
        y = y0 + li * line_h
        # Highlight boxes cover runs of consecutive highlighted words on the same line.
        i = 0
        while i < len(line):
            if line[i].highlight:
                j = i
                while j + 1 < len(line) and line[j + 1].highlight:
                    j += 1
                run_x = x + sum(font.getlength(t.text) + space for t in line[:i])
                run_w = sum(font.getlength(t.text) for t in line[i:j + 1]) + space * (j - i)
                d.rectangle((run_x - pad_x, y + cap_top - pad_top - 4,
                             run_x + run_w + pad_x, y + desc_bottom + pad_bottom - 6), fill=accent + (255,))
                i = j + 1
            else:
                i += 1
        cx = x
        for tok in line:
            if tok.highlight:
                d.text((cx, y), tok.text, font=font, fill=(17, 17, 17))
            else:
                sd.text((cx + 2, y + 3), tok.text, font=font, fill=(0, 0, 0, 170))
                d.text((cx, y), tok.text, font=font, fill=(255, 255, 255))
            cx += font.getlength(tok.text) + space
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(4)))
    canvas.alpha_composite(layer)
    return y0


def _draw_footer(canvas: Image.Image, icons: list[str], handle: str) -> None:
    d = ImageDraw.Draw(canvas)
    fonts = {"brands": _font("fa-brands-400.ttf", 30), "solid": _font("fa-solid-900.ttf", 28)}
    glyphs = [ICON_GLYPHS[i] for i in icons if i in ICON_GLYPHS]
    gap = 58
    color = (255, 255, 255, 150)
    if handle:
        hf = _font("Poppins-SemiBold.ttf", 26)
        hw = hf.getlength(handle)
        total = len(glyphs) * gap + (hw + 24 if glyphs else hw)
        x = (W - total) / 2
        for family, ch in glyphs:
            d.text((x + gap / 2, FOOTER_Y), ch, font=fonts[family], fill=color, anchor="mm")
            x += gap
        d.text((x + (12 if glyphs else 0), FOOTER_Y), handle, font=hf, fill=color, anchor="lm")
        return
    x = (W - len(glyphs) * gap) / 2
    for family, ch in glyphs:
        d.text((x + gap / 2, FOOTER_Y), ch, font=fonts[family], fill=color, anchor="mm")
        x += gap


def render_card(
    background: bytes,
    headline: str,
    highlights: list[str],
    *,
    brand_name: str = "Naya News",
    accent_hex: str = "#FFC72C",
    logo_png: bytes | None = None,
    frame_png: bytes | None = None,
    footer_icons: list[str] | None = None,
    footer_handle: str = "",
    ai_label: bool = False,
    enhance: float = 1.0,
) -> bytes:
    accent = hex_to_rgb(accent_hex)
    photo = enhance_photo(cover_fit(Image.open(io.BytesIO(background))), enhance)
    canvas = photo.convert("RGBA")
    # Light top shade keeps the logo readable; the bottom fade carries the headline.
    canvas.alpha_composite(_gradient_layer(0, 240, 105, top_down=True))
    canvas.alpha_composite(_gradient_layer(int(H * 0.47), int(H * 0.88), 238, top_down=False))

    _draw_headline(canvas, headline, highlights, accent)
    _draw_footer(canvas, footer_icons if footer_icons is not None else
                 ["facebook", "instagram", "x", "linkedin", "web"], footer_handle)

    if logo_png:
        logo = Image.open(io.BytesIO(logo_png)).convert("RGBA")
        logo.thumbnail((260, 170), Image.LANCZOS)
    else:
        logo = default_logo(brand_name, accent)
    canvas.alpha_composite(logo, (48, 44))

    if ai_label:
        d = ImageDraw.Draw(canvas)
        d.text((W - 28, 30), "AI-generated image", font=_font("Poppins-SemiBold.ttf", 20),
               fill=(255, 255, 255, 170), anchor="ra")

    if frame_png:
        frame = Image.open(io.BytesIO(frame_png)).convert("RGBA").resize((W, H), Image.LANCZOS)
        canvas.alpha_composite(frame)

    out = io.BytesIO()
    canvas.convert("RGB").save(out, "JPEG", quality=90, optimize=True, progressive=True)
    return out.getvalue()
