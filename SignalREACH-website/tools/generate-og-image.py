"""Regenerate assets/og-image.png (1200x630 social share card). Run: python tools/generate-og-image.py"""
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
W, H = 1200, 630
INK = (22, 22, 24)          # #161618
GOLD = (212, 175, 55)       # #d4af37
TEXT = (245, 245, 247)      # #f5f5f7
MUTED = (154, 154, 160)

FONTS = Path("C:/Windows/Fonts")
def font(name, size):
    return ImageFont.truetype(str(FONTS / name), size)

def text_w(draw, s, f):
    return draw.textlength(s, font=f)

img = Image.new("RGB", (W, H), INK)
d = ImageDraw.Draw(img)

# Faint oversized diamond backdrop, echoing the brand mark.
cx, cy, r = 1030, 120, 560
diamond = [(cx, cy - r), (cx + r, cy), (cx, cy + r), (cx - r, cy)]
d.polygon(diamond, outline=(32, 30, 26))

# Brand mark.
logo = Image.open(ROOT / "assets" / "logo.png").convert("RGBA").resize((300, 300), Image.LANCZOS)
img.paste(logo, (90, 165), logo)

x = 450
title1, title2 = "Signal", "REACH"
f_title = font("segoeuib.ttf", 104)
d.text((x, 190), title1, font=f_title, fill=TEXT)
d.text((x + text_w(d, title1, f_title), 190), title2, font=f_title, fill=GOLD)

f_tag = font("segoeui.ttf", 52)
d.text((x, 330), "Your ideas. Within REACH.", font=f_tag, fill=TEXT)

f_sub = font("segoeui.ttf", 34)
d.text((x, 420), "Open-source AI workspace ecosystem", font=f_sub, fill=MUTED)

f_url = font("segoeuib.ttf", 30)
d.text((x, 505), "signalreach.ca", font=f_url, fill=GOLD)

# Thin gold baseline accent.
d.rectangle([0, H - 12, W, H], fill=GOLD)

img.save(ROOT / "assets" / "og-image.png", optimize=True)
print("Wrote assets/og-image.png")
