import base64
import os
import shutil
import subprocess
import sys
from pathlib import Path
from PIL import Image, ImageDraw
import numpy as np
from scipy import ndimage

EDGE_EXE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
SRC_IMAGE_PATH = Path(r"C:\Users\Falab\.gemini\antigravity-ide\brain\1fca404e-5ea4-447b-9257-a93718c49dc0\.user_uploaded\media_1792708661019.jpg")
OUTPUT_DIR = Path(r"D:\SimpleREACH\studio\assets\microsoft-publishing")
STUDIO_ASSETS_DIR = Path(r"D:\SimpleREACH\studio\assets")
BRAIN_PREVIEWS_DIR = Path(r"C:\Users\Falab\.gemini\antigravity-ide\brain\1fca404e-5ea4-447b-9257-a93718c49dc0")

# Prepare directories
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
STUDIO_ASSETS_DIR.mkdir(parents=True, exist_ok=True)
BRAIN_PREVIEWS_DIR.mkdir(parents=True, exist_ok=True)

# 1. Load uploaded master image
print("Loading uploaded master image...")
src_img = Image.open(SRC_IMAGE_PATH).convert("RGB")
W, H = src_img.size  # 1024 x 1024
arr = np.array(src_img, dtype=np.float32)

# =========================================================================
# Master A: Squircle with Antialiased Transparent Corners (ZERO Rim Clipping)
# =========================================================================
# Flood-fill black background from the 4 corners: (0,0), (0,1023), (1023,0), (1023,1023)
is_black = (arr.max(axis=2) < 15)
labeled, _ = ndimage.label(is_black)
corner_labels = {labeled[0, 0], labeled[0, H-1], labeled[W-1, 0], labeled[W-1, H-1]} - {0}
corner_mask = np.isin(labeled, list(corner_labels))

# Antialias corner transparency with smooth Gaussian falloff
alpha_sq = np.where(corner_mask, 0.0, 255.0)
alpha_sq_smooth = ndimage.gaussian_filter(alpha_sq, sigma=0.8)
alpha_sq_final = np.clip(alpha_sq_smooth, 0, 255).astype(np.uint8)

res_squircle = np.zeros((W, H, 4), dtype=np.uint8)
res_squircle[:, :, :3] = np.clip(arr, 0, 255).astype(np.uint8)
res_squircle[:, :, 3] = alpha_sq_final
master_squircle_trans = Image.fromarray(res_squircle, "RGBA")

# =========================================================================
# Master B: Just the Logo & R with NO Background (100% Round Spheres, ZERO Cutoff)
# =========================================================================
# The 4 spheres end at distance ~388px from center (513, 513).
# Outer cutoff is set at 430px (well past all spheres, well inside squircle rim at 470px).
Y, X = np.indices((W, H))
dist = np.sqrt((X - 513.0)**2 + (Y - 513.0)**2)
outer_fade = np.clip((430.0 - dist) / 15.0, 0.0, 1.0)

# Luminance calculation
lum = 0.299 * arr[:, :, 0] + 0.587 * arr[:, :, 1] + 0.114 * arr[:, :, 2]

# Threshold:
# Negative space (inside loop of R, between legs of R, and dark canvas) has lum < 48 -> alpha = 0
# Solid gold surfaces have lum > 90 -> alpha = 1.0
# Antialiased cosine transition between 48 and 90 preserves complete round spherical curvature
alpha_norm = np.clip((lum - 48.0) / (90.0 - 48.0), 0.0, 1.0)
alpha_smooth = alpha_norm * alpha_norm * (3 - 2 * alpha_norm) * outer_fade

res_emblem = np.zeros((W, H, 4), dtype=np.uint8)
res_emblem[:, :, :3] = np.clip(arr, 0, 255).astype(np.uint8)
res_emblem[:, :, 3] = (alpha_smooth * 255.0).astype(np.uint8)
master_emblem_trans = Image.fromarray(res_emblem, "RGBA")

# Verify non-zero alpha bounding box
alpha_check = res_emblem[:, :, 3]
rows = np.where(np.any(alpha_check > 10, axis=1))[0]
cols = np.where(np.any(alpha_check > 10, axis=0))[0]
print(f"Master Emblem Bounding Box: y={rows[0]}..{rows[-1]}, x={cols[0]}..{cols[-1]}")
print(f"Emblem Size: {cols[-1]-cols[0]+1}x{rows[-1]-rows[0]+1} (Fully Unclipped Spherical Nodes)")

# Temporary scratch folder for base64 images
scratch_dir = Path(r"C:\Users\Falab\.gemini\antigravity-ide\scratch")
scratch_squircle = scratch_dir / "master_squircle_trans.png"
scratch_emblem = scratch_dir / "master_emblem_trans.png"
master_squircle_trans.save(scratch_squircle)
master_emblem_trans.save(scratch_emblem)

with open(scratch_squircle, "rb") as f:
    B64_SQUIRCLE = base64.b64encode(f.read()).decode("ascii")
with open(scratch_emblem, "rb") as f:
    B64_EMBLEM = base64.b64encode(f.read()).decode("ascii")

print("Base masters successfully prepared.")

# Common SVG Defs
COMMON_DEFS = f"""
    <!-- Outer background gradient -->
    <radialGradient id="heroBgGrad" cx="50%" cy="42%" r="65%">
      <stop offset="0%" stop-color="#1e1e24"/>
      <stop offset="55%" stop-color="#121215"/>
      <stop offset="100%" stop-color="#09090b"/>
    </radialGradient>

    <!-- Poster vertical background gradient -->
    <linearGradient id="posterBgGrad" x1="50%" y1="0%" x2="50%" y2="100%">
      <stop offset="0%" stop-color="#24242c"/>
      <stop offset="35%" stop-color="#18181e"/>
      <stop offset="70%" stop-color="#101013"/>
      <stop offset="100%" stop-color="#08080a"/>
    </linearGradient>

    <!-- Subtle border highlight -->
    <linearGradient id="borderGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#d4af37" stop-opacity="0.45"/>
      <stop offset="25%" stop-color="#ffffff" stop-opacity="0.08"/>
      <stop offset="75%" stop-color="#242429" stop-opacity="0.1"/>
      <stop offset="100%" stop-color="#d4af37" stop-opacity="0.3"/>
    </linearGradient>

    <!-- Core Ambient Gold Glow -->
    <radialGradient id="heroCoreGlow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#d4af37" stop-opacity="0.38"/>
      <stop offset="45%" stop-color="#d4af37" stop-opacity="0.18"/>
      <stop offset="75%" stop-color="#d4af37" stop-opacity="0.04"/>
      <stop offset="100%" stop-color="#d4af37" stop-opacity="0"/>
    </radialGradient>

    <!-- Premium Drop Shadow for Depth -->
    <filter id="emblemShadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="16" stdDeviation="22" flood-color="#000000" flood-opacity="0.8"/>
      <feDropShadow dx="0" dy="4" stdDeviation="12" flood-color="#d4af37" flood-opacity="0.35"/>
    </filter>

    <!-- Subtle Badge Pill Gradient -->
    <linearGradient id="pillBg" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#1f1f26"/>
      <stop offset="100%" stop-color="#15151a"/>
    </linearGradient>
    <linearGradient id="pillStroke" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#d4af37" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.08"/>
    </linearGradient>
"""

def render_svg_to_png(svg_str, png_path, width, height, transparent=False):
    tmp_svg = png_path.with_suffix(".tmp.svg")
    tmp_html = png_path.with_suffix(".tmp.html")

    tmp_svg.write_text(svg_str, encoding="utf-8")
    bg_style = "transparent" if transparent else "#09090b"

    html_content = f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body {{
    margin: 0;
    padding: 0;
    width: {width}px;
    height: {height}px;
    overflow: hidden;
    background: {bg_style};
  }}
  img {{
    width: {width}px;
    height: {height}px;
    display: block;
  }}
</style>
</head>
<body>
  <img src="file:///{tmp_svg.resolve().as_posix()}" />
</body>
</html>"""
    tmp_html.write_text(html_content, encoding="utf-8")

    args = [
        EDGE_EXE,
        "--headless=new",
        f"--window-size={width},{height}",
        f"--screenshot={png_path.resolve().as_posix()}",
        f"file:///{tmp_html.resolve().as_posix()}"
    ]
    if transparent:
        args.insert(2, "--default-background-color=00000000")

    res = subprocess.run(args, capture_output=True)
    if res.returncode != 0:
        print(f"Error rendering {png_path}: {res.stderr.decode('utf-8', errors='ignore')}")

    try:
        tmp_svg.unlink(missing_ok=True)
        tmp_html.unlink(missing_ok=True)
    except Exception:
        pass

    print(f"  [RENDERED] {png_path.name:55} ({width}x{height})")


# =========================================================================
# 1. 1:1 App Tiles, Logos & Transparent Emblems
# =========================================================================
def generate_square_tiles():
    print("\n1. Generating 1:1 App Tiles, Logos & Clean Transparent Emblems (No Background):")
    sizes = [
        ("microsoft-store-logo-1080x1080.png", 1080),
        ("microsoft-store-logo-720x720.png", 720),
        ("AppTileIcon-300x300.png", 300),
        ("StoreTile-150x150.png", 150),
        ("StoreTile-71x71.png", 71),
        ("Square310x310Logo.png", 310),
        ("Square150x150Logo.png", 150),
        ("StoreLogo.png", 50),
        ("Square44x44Logo.png", 44),
    ]

    for fname, sz in sizes:
        # 1. Standard Squircle Icon (Antialiased transparent outer corners, 100% full unclipped rim)
        out_p = OUTPUT_DIR / fname
        resized_squircle = master_squircle_trans.resize((sz, sz), Image.Resampling.LANCZOS)
        resized_squircle.save(out_p, "PNG")

        # 2. Transparent Emblem Variant (JUST the logo & R with NO background, 100% full round nodes)
        base_stem = fname.replace(".png", "")
        trans_fname = f"{base_stem}-transparent.png"
        trans_p = OUTPUT_DIR / trans_fname
        resized_emblem = master_emblem_trans.resize((sz, sz), Image.Resampling.LANCZOS)
        resized_emblem.save(trans_p, "PNG")
        print(f"  [SAVED] {trans_fname:55} ({sz}x{sz} Clean Transparent Logo & R)")

    # Pure standalone transparent logo masters (explicitly named for instant access)
    for sz in [1080, 720, 512, 300, 256, 150, 71, 44]:
        emblem_sz_p = OUTPUT_DIR / f"logo-transparent-{sz}x{sz}.png"
        master_emblem_trans.resize((sz, sz), Image.Resampling.LANCZOS).save(emblem_sz_p, "PNG")
        print(f"  [SAVED] logo-transparent-{sz}x{sz}.png")

    # Aliases for Partner Center direct drag-and-drop
    shutil.copy(OUTPUT_DIR / "AppTileIcon-300x300.png", OUTPUT_DIR / "1-1-App-tile-icon-300x300.png")
    shutil.copy(OUTPUT_DIR / "AppTileIcon-300x300-transparent.png", OUTPUT_DIR / "1-1-App-tile-icon-300x300-transparent.png")
    shutil.copy(OUTPUT_DIR / "StoreTile-150x150.png", OUTPUT_DIR / "1-1-tile-150x150.png")
    shutil.copy(OUTPUT_DIR / "StoreTile-150x150-transparent.png", OUTPUT_DIR / "1-1-tile-150x150-transparent.png")
    shutil.copy(OUTPUT_DIR / "StoreTile-71x71.png", OUTPUT_DIR / "1-1-tile-71x71.png")
    shutil.copy(OUTPUT_DIR / "StoreTile-71x71-transparent.png", OUTPUT_DIR / "1-1-tile-71x71-transparent.png")

    # Copies to STUDIO_ASSETS_DIR
    for fn in ["AppTileIcon-300x300.png", "AppTileIcon-300x300-transparent.png",
               "StoreTile-150x150.png", "StoreTile-150x150-transparent.png",
               "StoreTile-71x71.png", "StoreTile-71x71-transparent.png",
               "microsoft-store-logo-1080x1080.png", "microsoft-store-logo-1080x1080-transparent.png",
               "microsoft-store-logo-720x720.png", "microsoft-store-logo-720x720-transparent.png"]:
        shutil.copy(OUTPUT_DIR / fn, STUDIO_ASSETS_DIR / fn)

    # Generate multi-size Windows icon.ico, icon.png and icon-transparent.png
    print("\n   Generating Windows icon.ico & icon-transparent.png:")
    icon_png_p = STUDIO_ASSETS_DIR / "icon.png"
    master_squircle_trans.resize((512, 512), Image.Resampling.LANCZOS).save(icon_png_p, "PNG")

    icon_trans_p = STUDIO_ASSETS_DIR / "icon-transparent.png"
    master_emblem_trans.resize((512, 512), Image.Resampling.LANCZOS).save(icon_trans_p, "PNG")

    icon_ico_p = STUDIO_ASSETS_DIR / "icon.ico"
    ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    master_squircle_trans.save(icon_ico_p, format="ICO", sizes=ico_sizes)

    icon_icns_p = STUDIO_ASSETS_DIR / "icon.icns"
    try:
        master_squircle_trans.save(icon_icns_p, format="ICNS")
    except Exception:
        pass


# =========================================================================
# 2. 16:9 Super Hero Art (Features Just the Logo & R with NO background)
# =========================================================================
def build_superhero_16x9_stacked(w, h, p1="Signal", p2="REACH", sub="DESKTOP WORKSPACE FOR AI AGENTS"):
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width="{w}" height="{h}">
  <defs>{COMMON_DEFS}</defs>
  <rect width="1920" height="1080" fill="url(#heroBgGrad)"/>
  <rect x="28" y="28" width="1864" height="1024" rx="30" fill="none" stroke="url(#borderGrad)" stroke-width="1.6"/>
  <text x="960" y="155" text-anchor="middle" font-family="'Segoe UI', -apple-system, sans-serif" font-size="15" font-weight="700" letter-spacing="6" fill="#d4af37">
    AUTONOMOUS WORKSPACE
  </text>
  <path d="M840 180 L1080 180" stroke="url(#borderGrad)" stroke-width="1.2"/>
  <circle cx="960" cy="385" r="440" fill="url(#heroCoreGlow)"/>
  <g filter="url(#emblemShadow)">
    <image href="data:image/png;base64,{B64_EMBLEM}" x="710" y="135" width="500" height="500"/>
  </g>
  <text x="960" y="675" text-anchor="middle" font-family="'Segoe UI', -apple-system, sans-serif" font-size="94" font-weight="750" letter-spacing="-1.5">
    <tspan fill="#f5f5f7">{p1}</tspan><tspan fill="#d4af37">{p2}</tspan>
  </text>
  <text x="960" y="745" text-anchor="middle" font-family="'Segoe UI', -apple-system, sans-serif" font-size="26" font-weight="500" letter-spacing="6" fill="#a1a1aa">
    {sub}
  </text>
  <path d="M720 790 L1200 790" stroke="url(#borderGrad)" stroke-width="1.2"/>
  <g transform="translate(420, 830)">
    <rect x="0" y="0" width="320" height="48" rx="24" fill="url(#pillBg)" stroke="url(#pillStroke)" stroke-width="1.2"/>
    <text x="160" y="30" text-anchor="middle" font-family="'Segoe UI', sans-serif" font-size="14" font-weight="600" letter-spacing="1.5" fill="#d4af37">
      AUTONOMOUS AGENTS
    </text>
    <rect x="350" y="0" width="380" height="48" rx="24" fill="url(#pillBg)" stroke="url(#pillStroke)" stroke-width="1.2"/>
    <text x="540" y="30" text-anchor="middle" font-family="'Segoe UI', sans-serif" font-size="14" font-weight="600" letter-spacing="1.5" fill="#f5f5f7">
      INTEGRATED BROWSER &amp; CODE
    </text>
    <rect x="760" y="0" width="320" height="48" rx="24" fill="url(#pillBg)" stroke="url(#pillStroke)" stroke-width="1.2"/>
    <text x="920" y="30" text-anchor="middle" font-family="'Segoe UI', sans-serif" font-size="14" font-weight="600" letter-spacing="1.5" fill="#d4af37">
      WINDOWS 11 NATIVE CLIENT
    </text>
  </g>
  <text x="960" y="990" text-anchor="middle" font-family="'Segoe UI', sans-serif" font-size="14" font-weight="600" letter-spacing="3.5" fill="#71717a">
    MICROSOFT STORE 16:9 SUPER HERO ART
  </text>
</svg>"""

def build_superhero_16x9_wide(w, h):
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width="{w}" height="{h}">
  <defs>{COMMON_DEFS}</defs>
  <rect width="1920" height="1080" fill="url(#heroBgGrad)"/>
  <rect x="28" y="28" width="1864" height="1024" rx="30" fill="none" stroke="url(#borderGrad)" stroke-width="1.6"/>
  <circle cx="560" cy="540" r="480" fill="url(#heroCoreGlow)"/>
  <g filter="url(#emblemShadow)">
    <image href="data:image/png;base64,{B64_EMBLEM}" x="270" y="250" width="580" height="580"/>
  </g>
  <g transform="translate(880, 0)">
    <text x="0" y="440" font-family="'Segoe UI', -apple-system, sans-serif" font-size="16" font-weight="700" letter-spacing="5" fill="#d4af37">
      AUTONOMOUS AGENT WORKSPACE
    </text>
    <path d="M0 460 L320 460" stroke="url(#borderGrad)" stroke-width="1.2"/>
    <text x="0" y="555" font-family="'Segoe UI', -apple-system, sans-serif" font-size="105" font-weight="750" letter-spacing="-1.8">
      <tspan fill="#f5f5f7">Signal</tspan><tspan fill="#d4af37">REACH</tspan>
    </text>
    <text x="0" y="625" font-family="'Segoe UI', -apple-system, sans-serif" font-size="30" font-weight="500" letter-spacing="2.5" fill="#d4d4d8">
      Desktop Workspace for AI Agents
    </text>
    <text x="0" y="675" font-family="'Segoe UI', -apple-system, sans-serif" font-size="20" font-weight="400" letter-spacing="1" fill="#a1a1aa">
      Autonomous Teams • Browser Automation • Code &amp; Terminals
    </text>
    <path d="M0 715 L660 715" stroke="url(#borderGrad)" stroke-width="1.5"/>
    <text x="0" y="755" font-family="'Segoe UI', -apple-system, sans-serif" font-size="15" font-weight="600" letter-spacing="2" fill="#d4af37">
      MICROSOFT STORE SUPER HERO ART • 16:9 WIDESCREEN
    </text>
  </g>
</svg>"""

def build_superhero_16x9_emblem(w, h):
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width="{w}" height="{h}">
  <defs>{COMMON_DEFS}</defs>
  <rect width="1920" height="1080" fill="url(#heroBgGrad)"/>
  <rect x="28" y="28" width="1864" height="1024" rx="30" fill="none" stroke="url(#borderGrad)" stroke-width="1.6"/>
  <circle cx="960" cy="540" r="540" fill="url(#heroCoreGlow)"/>
  <g filter="url(#emblemShadow)">
    <image href="data:image/png;base64,{B64_EMBLEM}" x="570" y="150" width="780" height="780"/>
  </g>
</svg>"""

def build_superhero_16x9_emblem_transparent(w, h):
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width="{w}" height="{h}">
  <defs>{COMMON_DEFS}</defs>
  <circle cx="960" cy="540" r="540" fill="url(#heroCoreGlow)"/>
  <g filter="url(#emblemShadow)">
    <image href="data:image/png;base64,{B64_EMBLEM}" x="570" y="150" width="780" height="780"/>
  </g>
</svg>"""


# =========================================================================
# 3. 1:1 Square Showcase Cards (1080x1080)
# =========================================================================
def build_square_card_1080(p1="Signal", p2="REACH", sub="DESKTOP WORKSPACE FOR AI AGENTS"):
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1080" width="1080" height="1080">
  <defs>{COMMON_DEFS}</defs>
  <rect width="1080" height="1080" fill="url(#posterBgGrad)"/>
  <rect x="24" y="24" width="1032" height="1032" rx="28" fill="none" stroke="url(#borderGrad)" stroke-width="1.5"/>
  <text x="540" y="115" text-anchor="middle" font-family="'Segoe UI', sans-serif" font-size="14" font-weight="700" letter-spacing="5" fill="#d4af37">
    AUTONOMOUS WORKSPACE
  </text>
  <path d="M440 135 L640 135" stroke="url(#borderGrad)" stroke-width="1"/>
  <circle cx="540" cy="400" r="400" fill="url(#heroCoreGlow)"/>
  <g filter="url(#emblemShadow)">
    <image href="data:image/png;base64,{B64_EMBLEM}" x="290" y="150" width="500" height="500"/>
  </g>
  <text x="540" y="695" text-anchor="middle" font-family="'Segoe UI', sans-serif" font-size="76" font-weight="750" letter-spacing="-1.2">
    <tspan fill="#f5f5f7">{p1}</tspan><tspan fill="#d4af37">{p2}</tspan>
  </text>
  <text x="540" y="750" text-anchor="middle" font-family="'Segoe UI', sans-serif" font-size="20" font-weight="500" letter-spacing="4.5" fill="#a1a1aa">
    {sub}
  </text>
  <path d="M360 790 L720 790" stroke="url(#borderGrad)" stroke-width="1.2"/>
  <g transform="translate(230, 830)">
    <rect x="0" y="0" width="280" height="42" rx="21" fill="url(#pillBg)" stroke="url(#pillStroke)" stroke-width="1.2"/>
    <text x="140" y="27" text-anchor="middle" font-family="'Segoe UI', sans-serif" font-size="13" font-weight="600" letter-spacing="1.5" fill="#d4af37">
      AUTONOMOUS AGENTS
    </text>
    <rect x="310" y="0" width="310" height="42" rx="21" fill="url(#pillBg)" stroke="url(#pillStroke)" stroke-width="1.2"/>
    <text x="465" y="27" text-anchor="middle" font-family="'Segoe UI', sans-serif" font-size="13" font-weight="600" letter-spacing="1.5" fill="#f5f5f7">
      WINDOWS 11 NATIVE CLIENT
    </text>
  </g>
  <text x="540" y="995" text-anchor="middle" font-family="'Segoe UI', sans-serif" font-size="13" font-weight="600" letter-spacing="3" fill="#71717a">
    MICROSOFT STORE 1:1 SQUARE MASTER • 1080P
  </text>
</svg>"""


# =========================================================================
# 4. 1280x720 (720p 16:9) Hero & Promotional Banners
# =========================================================================
def build_hero_1280x720_stacked(p1="Signal", p2="REACH", sub="DESKTOP WORKSPACE FOR AI AGENTS"):
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="1280" height="720">
  <defs>{COMMON_DEFS}</defs>
  <rect width="1280" height="720" fill="url(#heroBgGrad)"/>
  <rect x="18" y="18" width="1244" height="684" rx="20" fill="none" stroke="url(#borderGrad)" stroke-width="1.2"/>
  <circle cx="640" cy="235" r="320" fill="url(#heroCoreGlow)"/>
  <g filter="url(#emblemShadow)">
    <image href="data:image/png;base64,{B64_EMBLEM}" x="465" y="60" width="350" height="350"/>
  </g>
  <text x="640" y="425" text-anchor="middle" font-family="'Segoe UI', sans-serif" font-size="64" font-weight="700" letter-spacing="-1">
    <tspan fill="#f5f5f7">{p1}</tspan><tspan fill="#d4af37">{p2}</tspan>
  </text>
  <text x="640" y="475" text-anchor="middle" font-family="'Segoe UI', sans-serif" font-size="19" font-weight="500" letter-spacing="4.5" fill="#a1a1aa">
    {sub}
  </text>
  <g transform="translate(325, 520)">
    <rect x="0" y="0" width="180" height="34" rx="17" fill="url(#pillBg)" stroke="url(#pillStroke)" stroke-width="1"/>
    <text x="90" y="22" text-anchor="middle" font-family="'Segoe UI', sans-serif" font-size="11" font-weight="600" letter-spacing="1" fill="#d4af37">
      AUTONOMOUS
    </text>
    <rect x="200" y="0" width="240" height="34" rx="17" fill="url(#pillBg)" stroke="url(#pillStroke)" stroke-width="1"/>
    <text x="320" y="22" text-anchor="middle" font-family="'Segoe UI', sans-serif" font-size="11" font-weight="600" letter-spacing="1" fill="#f5f5f7">
      BROWSER &amp; CODE AGENTS
    </text>
    <rect x="460" y="0" width="170" height="34" rx="17" fill="url(#pillBg)" stroke="url(#pillStroke)" stroke-width="1"/>
    <text x="545" y="22" text-anchor="middle" font-family="'Segoe UI', sans-serif" font-size="11" font-weight="600" letter-spacing="1" fill="#d4af37">
      WIN 11 NATIVE
    </text>
  </g>
  <text x="640" y="650" text-anchor="middle" font-family="'Segoe UI', sans-serif" font-size="11" font-weight="600" letter-spacing="3" fill="#71717a">
    MICROSOFT STORE 720P PROMOTIONAL HERO BANNER
  </text>
</svg>"""

def build_hero_1280x720_wide():
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="1280" height="720">
  <defs>{COMMON_DEFS}</defs>
  <rect width="1280" height="720" fill="url(#heroBgGrad)"/>
  <rect x="18" y="18" width="1244" height="684" rx="20" fill="none" stroke="url(#borderGrad)" stroke-width="1.2"/>
  <circle cx="360" cy="360" r="340" fill="url(#heroCoreGlow)"/>
  <g filter="url(#emblemShadow)">
    <image href="data:image/png;base64,{B64_EMBLEM}" x="150" y="150" width="420" height="420"/>
  </g>
  <g transform="translate(580, 0)">
    <text x="0" y="290" font-family="'Segoe UI', sans-serif" font-size="13" font-weight="700" letter-spacing="4" fill="#d4af37">
      AUTONOMOUS WORKSPACE
    </text>
    <path d="M0 305 L240 305" stroke="url(#borderGrad)" stroke-width="1"/>
    <text x="0" y="380" font-family="'Segoe UI', sans-serif" font-size="76" font-weight="750" letter-spacing="-1.5">
      <tspan fill="#f5f5f7">Signal</tspan><tspan fill="#d4af37">REACH</tspan>
    </text>
    <text x="0" y="430" font-family="'Segoe UI', sans-serif" font-size="22" font-weight="500" letter-spacing="2" fill="#d4d4d8">
      Desktop Workspace for AI Agents
    </text>
    <text x="0" y="470" font-family="'Segoe UI', sans-serif" font-size="15" font-weight="400" letter-spacing="0.5" fill="#a1a1aa">
      Autonomous Teams • Browser Automation • Code &amp; Terminals
    </text>
    <path d="M0 505 L540 505" stroke="url(#borderGrad)" stroke-width="1.2"/>
    <text x="0" y="538" font-family="'Segoe UI', sans-serif" font-size="12" font-weight="600" letter-spacing="2" fill="#d4af37">
      MICROSOFT STORE 720P HORIZONTAL HERO BANNER
    </text>
  </g>
</svg>"""

def build_hero_1280x720_emblem():
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="1280" height="720">
  <defs>{COMMON_DEFS}</defs>
  <rect width="1280" height="720" fill="url(#heroBgGrad)"/>
  <rect x="18" y="18" width="1244" height="684" rx="20" fill="none" stroke="url(#borderGrad)" stroke-width="1.2"/>
  <circle cx="640" cy="360" r="360" fill="url(#heroCoreGlow)"/>
  <g filter="url(#emblemShadow)">
    <image href="data:image/png;base64,{B64_EMBLEM}" x="365" y="85" width="550" height="550"/>
  </g>
</svg>"""

def build_hero_1280x720_transparent():
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="1280" height="720">
  <defs>{COMMON_DEFS}</defs>
  <circle cx="640" cy="360" r="360" fill="url(#heroCoreGlow)"/>
  <g filter="url(#emblemShadow)">
    <image href="data:image/png;base64,{B64_EMBLEM}" x="365" y="85" width="550" height="550"/>
  </g>
</svg>"""


# =========================================================================
# 5. Vertical Poster Art (2:3 & 9:16)
# =========================================================================
def build_poster_2x3(w, h, p1="Signal", p2="REACH", sub="DESKTOP WORKSPACE FOR AI AGENTS"):
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 1080" width="{w}" height="{h}">
  <defs>{COMMON_DEFS}</defs>
  <rect width="720" height="1080" fill="url(#posterBgGrad)"/>
  <rect x="22" y="22" width="676" height="1036" rx="26" fill="none" stroke="url(#borderGrad)" stroke-width="1.5"/>
  <text x="360" y="130" text-anchor="middle" font-family="'Segoe UI', sans-serif" font-size="13" font-weight="700" letter-spacing="5" fill="#d4af37">
    AUTONOMOUS WORKSPACE
  </text>
  <path d="M260 150 L460 150" stroke="url(#borderGrad)" stroke-width="1"/>
  <circle cx="360" cy="410" r="360" fill="url(#heroCoreGlow)"/>
  <g filter="url(#emblemShadow)">
    <image href="data:image/png;base64,{B64_EMBLEM}" x="120" y="170" width="480" height="480"/>
  </g>
  <text x="360" y="695" text-anchor="middle" font-family="'Segoe UI', sans-serif" font-size="64" font-weight="750" letter-spacing="-1.2">
    <tspan fill="#f5f5f7">{p1}</tspan><tspan fill="#d4af37">{p2}</tspan>
  </text>
  <text x="360" y="745" text-anchor="middle" font-family="'Segoe UI', sans-serif" font-size="17" font-weight="500" letter-spacing="4" fill="#a1a1aa">
    {sub}
  </text>
  <path d="M220 785 L500 785" stroke="url(#borderGrad)" stroke-width="1.2"/>
  <g transform="translate(195, 825)">
    <rect x="0" y="0" width="330" height="44" rx="22" fill="url(#pillBg)" stroke="url(#pillStroke)" stroke-width="1.2"/>
    <text x="165" y="28" text-anchor="middle" font-family="'Segoe UI', sans-serif" font-size="13" font-weight="600" letter-spacing="1.5" fill="#d4af37">
      AUTONOMOUS AGENTS
    </text>
    <rect x="0" y="58" width="330" height="44" rx="22" fill="url(#pillBg)" stroke="url(#pillStroke)" stroke-width="1.2"/>
    <text x="165" y="86" text-anchor="middle" font-family="'Segoe UI', sans-serif" font-size="13" font-weight="600" letter-spacing="1.5" fill="#f5f5f7">
      WINDOWS 11 NATIVE CLIENT
    </text>
  </g>
  <text x="360" y="1000" text-anchor="middle" font-family="'Segoe UI', sans-serif" font-size="12" font-weight="600" letter-spacing="3" fill="#71717a">
    MICROSOFT STORE POSTER ART
  </text>
</svg>"""

def build_poster_9x16(w, h, p1="Signal", p2="REACH", sub="DESKTOP WORKSPACE FOR AI AGENTS"):
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 1280" width="{w}" height="{h}">
  <defs>{COMMON_DEFS}</defs>
  <rect width="720" height="1280" fill="url(#posterBgGrad)"/>
  <rect x="24" y="24" width="672" height="1232" rx="28" fill="none" stroke="url(#borderGrad)" stroke-width="1.5"/>
  <text x="360" y="160" text-anchor="middle" font-family="'Segoe UI', sans-serif" font-size="14" font-weight="700" letter-spacing="5" fill="#d4af37">
    AUTONOMOUS WORKSPACE
  </text>
  <path d="M260 185 L460 185" stroke="url(#borderGrad)" stroke-width="1"/>
  <circle cx="360" cy="480" r="380" fill="url(#heroCoreGlow)"/>
  <g filter="url(#emblemShadow)">
    <image href="data:image/png;base64,{B64_EMBLEM}" x="110" y="230" width="500" height="500"/>
  </g>
  <text x="360" y="795" text-anchor="middle" font-family="'Segoe UI', sans-serif" font-size="68" font-weight="750" letter-spacing="-1.2">
    <tspan fill="#f5f5f7">{p1}</tspan><tspan fill="#d4af37">{p2}</tspan>
  </text>
  <text x="360" y="850" text-anchor="middle" font-family="'Segoe UI', sans-serif" font-size="18" font-weight="500" letter-spacing="4" fill="#a1a1aa">
    {sub}
  </text>
  <path d="M220 895 L500 895" stroke="url(#borderGrad)" stroke-width="1.2"/>
  <g transform="translate(190, 940)">
    <rect x="0" y="0" width="340" height="46" rx="23" fill="url(#pillBg)" stroke="url(#pillStroke)" stroke-width="1.2"/>
    <text x="170" y="29" text-anchor="middle" font-family="'Segoe UI', sans-serif" font-size="13" font-weight="600" letter-spacing="2" fill="#d4af37">
      AUTONOMOUS AGENTS
    </text>
    <rect x="0" y="62" width="340" height="46" rx="23" fill="url(#pillBg)" stroke="url(#pillStroke)" stroke-width="1.2"/>
    <text x="170" y="91" text-anchor="middle" font-family="'Segoe UI', sans-serif" font-size="13" font-weight="600" letter-spacing="2" fill="#f5f5f7">
      BROWSER &amp; CODE AGENTS
    </text>
    <rect x="0" y="124" width="340" height="46" rx="23" fill="url(#pillBg)" stroke="url(#pillStroke)" stroke-width="1.2"/>
    <text x="170" y="153" text-anchor="middle" font-family="'Segoe UI', sans-serif" font-size="13" font-weight="600" letter-spacing="2" fill="#d4af37">
      WINDOWS 11 NATIVE CLIENT
    </text>
  </g>
  <text x="360" y="1185" text-anchor="middle" font-family="'Segoe UI', sans-serif" font-size="12" font-weight="600" letter-spacing="3" fill="#71717a">
    MICROSOFT STORE 9:16 POSTER ART
  </text>
</svg>"""


# =========================================================================
# 6. Windows AppX / MSIX Package Tiles (Wide310x150 & SplashScreen)
# =========================================================================
def build_wide_tile(w=310, h=150):
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">
  <defs>{COMMON_DEFS}</defs>
  <rect width="{w}" height="{h}" fill="url(#heroBgGrad)"/>
  <rect x="2" y="2" width="{w-4}" height="{h-4}" rx="8" fill="none" stroke="url(#borderGrad)" stroke-width="1"/>
  <circle cx="{h // 2}" cy="{h // 2}" r="{h // 2}" fill="url(#heroCoreGlow)"/>
  <g filter="url(#emblemShadow)">
    <image href="data:image/png;base64,{B64_EMBLEM}" x="10" y="10" width="{h-20}" height="{h-20}"/>
  </g>
  <text x="{h + 10}" y="{h // 2 + 7}" font-family="'Segoe UI', sans-serif" font-size="28" font-weight="700">
    <tspan fill="#f5f5f7">Signal</tspan><tspan fill="#d4af37">REACH</tspan>
  </text>
</svg>"""

def build_splash(w=620, h=300):
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">
  <defs>{COMMON_DEFS}</defs>
  <rect width="{w}" height="{h}" fill="url(#heroBgGrad)"/>
  <circle cx="{w // 2}" cy="{h // 2 - 20}" r="150" fill="url(#heroCoreGlow)"/>
  <g filter="url(#emblemShadow)">
    <image href="data:image/png;base64,{B64_EMBLEM}" x="{w // 2 - 80}" y="{h // 2 - 100}" width="160" height="160"/>
  </g>
  <text x="{w // 2}" y="{h // 2 + 80}" text-anchor="middle" font-family="'Segoe UI', sans-serif" font-size="26" font-weight="700">
    <tspan fill="#f5f5f7">Signal</tspan><tspan fill="#d4af37">REACH</tspan>
  </text>
</svg>"""


# =========================================================================
# Main Execution Flow
# =========================================================================
def main():
    print("=" * 70)
    print("STARTING FULL ZERO-CLIPPING MICROSOFT STORE ASSET SUITE GENERATION")
    print(f"Master Image: {SRC_IMAGE_PATH}")
    print(f"Output Directory: {OUTPUT_DIR}")
    print("=" * 70)

    # 1. 1:1 App Tiles, Logos & Clean Transparent Emblems
    generate_square_tiles()

    # 2. 16:9 Super Hero Art (Centered Clean Logo & R)
    print("\n2. Generating 16:9 Super Hero Art (Centered Clean Logo & R):")
    render_svg_to_png(build_superhero_16x9_stacked(1920, 1080, "Signal", "REACH"), OUTPUT_DIR / "microsoft-store-superhero-1920x1080.png", 1920, 1080)
    render_svg_to_png(build_superhero_16x9_stacked(3840, 2160, "Signal", "REACH"), OUTPUT_DIR / "microsoft-store-superhero-3840x2160.png", 3840, 2160)
    shutil.copy(OUTPUT_DIR / "microsoft-store-superhero-1920x1080.png", OUTPUT_DIR / "16-9-Super-hero-art-1920x1080.png")
    shutil.copy(OUTPUT_DIR / "microsoft-store-superhero-3840x2160.png", OUTPUT_DIR / "16-9-Super-hero-art-3840x2160.png")
    shutil.copy(OUTPUT_DIR / "microsoft-store-superhero-1920x1080.png", STUDIO_ASSETS_DIR / "microsoft-store-superhero-1920x1080.png")
    shutil.copy(OUTPUT_DIR / "microsoft-store-superhero-3840x2160.png", STUDIO_ASSETS_DIR / "microsoft-store-superhero-3840x2160.png")

    render_svg_to_png(build_superhero_16x9_wide(1920, 1080), OUTPUT_DIR / "microsoft-store-superhero-wide-1920x1080.png", 1920, 1080)
    render_svg_to_png(build_superhero_16x9_wide(3840, 2160), OUTPUT_DIR / "microsoft-store-superhero-wide-3840x2160.png", 3840, 2160)

    render_svg_to_png(build_superhero_16x9_stacked(1920, 1080, "Reach ", "Studio", "AUTONOMOUS WORKSPACE FOR AI AGENTS"), OUTPUT_DIR / "microsoft-store-superhero-reachstudio-1920x1080.png", 1920, 1080)
    render_svg_to_png(build_superhero_16x9_stacked(3840, 2160, "Reach ", "Studio", "AUTONOMOUS WORKSPACE FOR AI AGENTS"), OUTPUT_DIR / "microsoft-store-superhero-reachstudio-3840x2160.png", 3840, 2160)

    render_svg_to_png(build_superhero_16x9_emblem(1920, 1080), OUTPUT_DIR / "microsoft-store-superhero-emblem-1920x1080.png", 1920, 1080)
    render_svg_to_png(build_superhero_16x9_emblem(3840, 2160), OUTPUT_DIR / "microsoft-store-superhero-emblem-3840x2160.png", 3840, 2160)

    # Transparent 16:9 Super Hero Arts
    render_svg_to_png(build_superhero_16x9_emblem_transparent(1920, 1080), OUTPUT_DIR / "microsoft-store-superhero-emblem-transparent-1920x1080.png", 1920, 1080, transparent=True)
    render_svg_to_png(build_superhero_16x9_emblem_transparent(3840, 2160), OUTPUT_DIR / "microsoft-store-superhero-emblem-transparent-3840x2160.png", 3840, 2160, transparent=True)

    # 3. 1:1 Square Showcase Cards (1080p)
    print("\n3. Generating 1:1 Square Showcase Cards (1080x1080):")
    render_svg_to_png(build_square_card_1080("Signal", "REACH"), OUTPUT_DIR / "microsoft-store-square-card-1080x1080.png", 1080, 1080)
    render_svg_to_png(build_square_card_1080("Reach ", "Studio", "AUTONOMOUS WORKSPACE FOR AI AGENTS"), OUTPUT_DIR / "microsoft-store-square-card-reachstudio-1080x1080.png", 1080, 1080)
    shutil.copy(OUTPUT_DIR / "microsoft-store-square-card-1080x1080.png", STUDIO_ASSETS_DIR / "microsoft-store-square-card-1080x1080.png")

    # 4. 1280x720 (720p 16:9) Hero & Promotional Banners
    print("\n4. Generating 1280x720 Promotional Banners:")
    render_svg_to_png(build_hero_1280x720_stacked("Signal", "REACH"), OUTPUT_DIR / "microsoft-store-hero-1280x720.png", 1280, 720)
    render_svg_to_png(build_hero_1280x720_wide(), OUTPUT_DIR / "microsoft-store-hero-wide-1280x720.png", 1280, 720)
    render_svg_to_png(build_hero_1280x720_stacked("Reach ", "Studio", "AUTONOMOUS WORKSPACE FOR AI AGENTS"), OUTPUT_DIR / "microsoft-store-hero-reachstudio-1280x720.png", 1280, 720)
    render_svg_to_png(build_hero_1280x720_emblem(), OUTPUT_DIR / "microsoft-store-hero-emblem-1280x720.png", 1280, 720)
    render_svg_to_png(build_hero_1280x720_transparent(), OUTPUT_DIR / "microsoft-store-hero-transparent-1280x720.png", 1280, 720, transparent=True)
    shutil.copy(OUTPUT_DIR / "microsoft-store-hero-1280x720.png", STUDIO_ASSETS_DIR / "microsoft-store-hero-1280x720.png")

    # 5. Vertical Poster Art (2:3 & 9:16)
    print("\n5. Generating Vertical Poster Art:")
    render_svg_to_png(build_poster_2x3(720, 1080, "Signal", "REACH"), OUTPUT_DIR / "microsoft-store-poster-720x1080.png", 720, 1080)
    render_svg_to_png(build_poster_2x3(1440, 2160, "Signal", "REACH"), OUTPUT_DIR / "microsoft-store-poster-1440x2160.png", 1440, 2160)
    render_svg_to_png(build_poster_2x3(720, 1080, "Reach ", "Studio", "AUTONOMOUS WORKSPACE FOR AI AGENTS"), OUTPUT_DIR / "microsoft-store-poster-reachstudio-720x1080.png", 720, 1080)
    render_svg_to_png(build_poster_2x3(1440, 2160, "Reach ", "Studio", "AUTONOMOUS WORKSPACE FOR AI AGENTS"), OUTPUT_DIR / "microsoft-store-poster-reachstudio-1440x2160.png", 1440, 2160)
    shutil.copy(OUTPUT_DIR / "microsoft-store-poster-720x1080.png", STUDIO_ASSETS_DIR / "microsoft-store-poster-720x1080.png")
    shutil.copy(OUTPUT_DIR / "microsoft-store-poster-1440x2160.png", STUDIO_ASSETS_DIR / "microsoft-store-poster-1440x2160.png")

    render_svg_to_png(build_poster_9x16(720, 1280, "Signal", "REACH"), OUTPUT_DIR / "microsoft-store-poster-9x16-720x1280.png", 720, 1280)
    render_svg_to_png(build_poster_9x16(1080, 1920, "Signal", "REACH"), OUTPUT_DIR / "microsoft-store-poster-9x16-1080x1920.png", 1080, 1920)

    # 6. Windows AppX / MSIX Package Tiles (Wide310x150 & SplashScreen)
    print("\n6. Generating Windows AppX Package Tiles:")
    render_svg_to_png(build_wide_tile(310, 150), OUTPUT_DIR / "Wide310x150Logo.png", 310, 150)
    render_svg_to_png(build_splash(620, 300), OUTPUT_DIR / "SplashScreen.png", 620, 300)

    # 7. Copy Visual Previews to current brain directory for markdown presentation
    print("\n7. Copying visual previews to brain artifact directory:")
    preview_mappings = [
        ("microsoft-store-superhero-1920x1080.png", "superhero-1920x1080.png"),
        ("microsoft-store-superhero-wide-1920x1080.png", "superhero-wide-1920x1080.png"),
        ("microsoft-store-poster-720x1080.png", "poster-720x1080.png"),
        ("microsoft-store-poster-9x16-720x1280.png", "poster-9x16-720x1280.png"),
        ("microsoft-store-logo-1080x1080.png", "logo-1080x1080.png"),
        ("microsoft-store-logo-1080x1080-transparent.png", "logo-transparent-1080x1080.png"),
        ("microsoft-store-logo-720x720.png", "logo-720x720.png"),
        ("microsoft-store-square-card-1080x1080.png", "square-card-1080x1080.png"),
        ("microsoft-store-hero-1280x720.png", "hero-1280x720.png"),
        ("microsoft-store-hero-wide-1280x720.png", "hero-wide-1280x720.png"),
        ("AppTileIcon-300x300.png", "tile-300x300.png"),
        ("AppTileIcon-300x300-transparent.png", "tile-300x300-transparent.png"),
        ("StoreTile-150x150.png", "tile-150x150.png"),
        ("StoreTile-150x150-transparent.png", "tile-150x150-transparent.png"),
        ("StoreTile-71x71.png", "tile-71x71.png"),
        ("StoreTile-71x71-transparent.png", "tile-71x71-transparent.png"),
    ]
    for src_name, dst_name in preview_mappings:
        src_f = OUTPUT_DIR / src_name
        dst_f = BRAIN_PREVIEWS_DIR / dst_name
        if src_f.exists():
            shutil.copy(src_f, dst_f)
            print(f"  [COPIED PREVIEW] {dst_name}")

    # 8. Copy generator script to D:\SimpleREACH\studio\scripts\generate-microsoft-publishing-assets.py
    target_script = Path(r"D:\SimpleREACH\studio\scripts\generate-microsoft-publishing-assets.py")
    try:
        shutil.copy(Path(__file__), target_script)
        print(f"\n[UPDATED SCRIPT] {target_script}")
    except Exception as e:
        print(f"Note: {e}")

    print("\n" + "=" * 70)
    print("ALL MICROSOFT STORE ASSETS WITH ZERO CLIPPING SUCCESSFULLY GENERATED!")
    print("=" * 70)

if __name__ == "__main__":
    main()
