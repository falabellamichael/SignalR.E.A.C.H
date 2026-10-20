"""
Generate Microsoft Store Publishing Brand Assets for SignalR.E.A.C.H / Reach Studio.

Covers:
1. 16:9 Super Hero Art (1920x1080 and 3840x2160):
   - microsoft-store-superhero-1920x1080.png (1920 x 1080 — 16:9 Super hero art 1080p standard)
   - microsoft-store-superhero-3840x2160.png (3840 x 2160 — 16:9 Super hero art 4K UHD master)
   - microsoft-store-superhero-wide-1920x1080.png & wide-3840x2160.png (Cinematic horizontal lockup)
   - microsoft-store-superhero-reachstudio-1920x1080.png & reachstudio-3840x2160.png
   - microsoft-store-superhero-emblem-1920x1080.png & emblem-3840x2160.png (Pure glowing emblem)
2. Store Display Images (Exact Microsoft Partner Center Slots):
   - AppTileIcon-300x300.png & 1-1-App-tile-icon-300x300.png (300 x 300 — 1:1 App tile icon)
   - StoreTile-150x150.png & 1-1-tile-150x150.png (150 x 150 — 1:1)
   - StoreTile-71x71.png & 1-1-tile-71x71.png (71 x 71 — 1:1)
3. 1:1 Square Logos & Cards at 1080p and 720p:
   - microsoft-store-logo-1080x1080.png (1080 x 1080 — 1:1 at 1080p)
   - microsoft-store-logo-1080x1080-transparent.png (1080 x 1080)
   - microsoft-store-square-card-1080x1080.png (1080 x 1080 showcase card)
   - microsoft-store-square-card-reachstudio-1080x1080.png (1080 x 1080 Reach Studio)
   - microsoft-store-logo-720x720.png (720 x 720)
   - microsoft-store-logo-720x720-transparent.png (720 x 720)
4. 1280x720 (720p standard 16:9) Promotional Artwork / Hero Banners:
   - microsoft-store-hero-1280x720.png (Stacked centered hero banner)
   - microsoft-store-hero-wide-1280x720.png (Horizontal cinematic hero banner)
   - microsoft-store-hero-reachstudio-1280x720.png (Reach Studio hero banner)
   - microsoft-store-hero-emblem-1280x720.png (Pure glowing emblem hero)
   - microsoft-store-hero-transparent-1280x720.png (Transparent brand lockup)
5. Vertical Poster Art (2:3 and 9:16 Aspect Ratios):
   - microsoft-store-poster-720x1080.png (720 x 1080 — 2:3 Microsoft Store standard poster art)
   - microsoft-store-poster-1440x2160.png (1440 x 2160 — 2:3 Microsoft Store high-res 2x poster art)
   - microsoft-store-poster-reachstudio-720x1080.png (720 x 1080 — Reach Studio edition)
   - microsoft-store-poster-reachstudio-1440x2160.png (1440 x 2160 — Reach Studio edition)
   - microsoft-store-poster-9x16-720x1280.png (720 x 1280 — 9:16 vertical poster art)
   - microsoft-store-poster-9x16-1080x1920.png (1080 x 1920 — 9:16 Full HD portrait poster art)
6. Windows AppX / MSIX Tile Assets (derived from vector master):
   - Square44x44Logo.png (44x44)
   - Square150x150Logo.png (150x150)
   - Square310x310Logo.png (310x310)
   - Wide310x150Logo.png (310x150)
   - StoreLogo.png (50x50)
   - SplashScreen.png (620x300)
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path
from PIL import Image

EDGE_EXE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
OUTPUT_DIR = Path(r"D:\SimpleREACH\studio\assets\microsoft-publishing")
STUDIO_ASSETS_DIR = Path(r"D:\SimpleREACH\studio\assets")

EMBLEM_DEFS = """
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
      <stop offset="0%" stop-color="#d4af37" stop-opacity="0.28"/>
      <stop offset="45%" stop-color="#d4af37" stop-opacity="0.12"/>
      <stop offset="75%" stop-color="#d4af37" stop-opacity="0.03"/>
      <stop offset="100%" stop-color="#d4af37" stop-opacity="0"/>
    </radialGradient>

    <!-- Squircle container background deep graphite gradient -->
    <linearGradient id="sqBgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#242429"/>
      <stop offset="40%" stop-color="#161619"/>
      <stop offset="100%" stop-color="#0d0d0f"/>
    </linearGradient>

    <!-- Outer rim metallic highlight -->
    <linearGradient id="rimGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#f5e18a" stop-opacity="0.85"/>
      <stop offset="30%" stop-color="#d4af37" stop-opacity="0.45"/>
      <stop offset="70%" stop-color="#4a3e14" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="#d4af37" stop-opacity="0.55"/>
    </linearGradient>

    <!-- Inner rim soft highlight -->
    <linearGradient id="innerRim" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.15"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.35"/>
    </linearGradient>

    <!-- Gold Metallic Gradient for Emblem -->
    <linearGradient id="goldMetallic" x1="25%" y1="0%" x2="75%" y2="100%">
      <stop offset="0%" stop-color="#fff5cc"/>
      <stop offset="25%" stop-color="#fad66a"/>
      <stop offset="70%" stop-color="#d4af37"/>
      <stop offset="100%" stop-color="#a4801f"/>
    </linearGradient>

    <!-- Node 3D Spherical Radial Lighting -->
    <radialGradient id="nodeLight" cx="35%" cy="35%" r="65%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="45%" stop-color="#fad66a"/>
      <stop offset="85%" stop-color="#d4af37"/>
      <stop offset="100%" stop-color="#7a5e12"/>
    </radialGradient>

    <!-- Premium Drop Shadow for Depth -->
    <filter id="emblemShadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="12" stdDeviation="18" flood-color="#000000" flood-opacity="0.65"/>
      <feDropShadow dx="0" dy="2" stdDeviation="8" flood-color="#d4af37" flood-opacity="0.35"/>
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

RAW_EMBLEM = """
  <g id="brand-emblem" filter="url(#emblemShadow)">
    <!-- Diamond Outline -->
    <path d="M256 96 L416 256 L256 416 L96 256 Z"
          fill="none" stroke="url(#goldMetallic)" stroke-width="24" stroke-linejoin="round"/>

    <!-- 4 Connection Nodes -->
    <circle cx="256" cy="96" r="28" fill="url(#nodeLight)"/>
    <circle cx="416" cy="256" r="28" fill="url(#nodeLight)"/>
    <circle cx="256" cy="416" r="28" fill="url(#nodeLight)"/>
    <circle cx="96" cy="256" r="28" fill="url(#nodeLight)"/>

    <!-- Balanced Centered 'R' -->
    <g transform="translate(256, 256) scale(0.77) translate(-256, -256)">
      <path d="M208 174 H266 C296 174 314 192 314 218 C314 238 300 254 278 259 L318 340 H284 L248 266 H236 V340 H208 V174 Z
               M236 198 V242 H264 C280 242 288 234 288 220 C288 206 280 198 264 198 H236 Z"
            fill="url(#goldMetallic)"/>
    </g>
  </g>
"""

def render_svg_to_png(svg_str, png_path, width, height, transparent=False):
    tmp_svg = png_path.with_suffix('.tmp.svg')
    tmp_html = png_path.with_suffix('.tmp.html')

    tmp_svg.write_text(svg_str, encoding='utf-8')
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
  <img src="file:///{tmp_svg.as_posix()}" />
</body>
</html>"""
    tmp_html.write_text(html_content, encoding='utf-8')

    args = [
        EDGE_EXE,
        "--headless=new",
        f"--window-size={width},{height}",
        f"--screenshot={png_path.as_posix()}",
        f"file:///{tmp_html.as_posix()}"
    ]
    if transparent:
        args.insert(2, "--default-background-color=00000000")

    subprocess.run(args, capture_output=True, check=True)

    tmp_svg.unlink(missing_ok=True)
    tmp_html.unlink(missing_ok=True)

    im = Image.open(png_path)
    print(f"  [OK] {png_path.name:52} size={im.size} mode={im.mode}")
    return im

def build_square_logo(size=720):
    """Generates square Windows 11 Fluent Squircle store logo at given size (720, 1080, etc.)."""
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="{size}" height="{size}">
  <defs>{EMBLEM_DEFS}</defs>
  <rect x="20" y="20" width="472" height="472" rx="112" fill="url(#sqBgGrad)" stroke="url(#rimGrad)" stroke-width="3"/>
  <rect x="23" y="23" width="466" height="466" rx="109" fill="none" stroke="url(#innerRim)" stroke-width="1.5"/>
  <circle cx="256" cy="256" r="190" fill="url(#heroCoreGlow)"/>
{RAW_EMBLEM}
</svg>"""

def build_square_logo_transparent(size=720):
    """Generates square transparent store logo at given size (720, 1080, etc.)."""
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="{size}" height="{size}">
  <defs>{EMBLEM_DEFS}</defs>
  <circle cx="256" cy="256" r="190" fill="url(#heroCoreGlow)"/>
{RAW_EMBLEM}
</svg>"""

def build_square_card_1080_svg(title_p1="Signal", title_p2="REACH", subtitle="DESKTOP WORKSPACE FOR AI AGENTS"):
    """
    Generates 1:1 at 1080p (1080 x 1080) Square Showcase Card / Banner for store listings.
    """
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1080" width="1080" height="1080">
  <defs>{EMBLEM_DEFS}</defs>
  <rect width="1080" height="1080" fill="url(#posterBgGrad)"/>
  <rect x="24" y="24" width="1032" height="1032" rx="28" fill="none" stroke="url(#borderGrad)" stroke-width="1.5"/>
  <text x="540" y="115" text-anchor="middle" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="14" font-weight="700" letter-spacing="5" fill="#d4af37">
    AUTONOMOUS WORKSPACE
  </text>
  <path d="M440 135 L640 135" stroke="url(#borderGrad)" stroke-width="1"/>
  <circle cx="540" cy="400" r="400" fill="url(#heroCoreGlow)"/>
  <g transform="translate(540, 390) scale(0.85) translate(-256, -256)">
{RAW_EMBLEM}
  </g>
  <text x="540" y="695" text-anchor="middle" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="76" font-weight="750" letter-spacing="-1.2">
    <tspan fill="#f5f5f7">{title_p1}</tspan><tspan fill="#d4af37">{title_p2}</tspan>
  </text>
  <text x="540" y="750" text-anchor="middle" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="20" font-weight="500" letter-spacing="4.5" fill="#a1a1aa">
    {subtitle}
  </text>
  <path d="M360 790 L720 790" stroke="url(#borderGrad)" stroke-width="1.2"/>
  <g transform="translate(230, 830)">
    <rect x="0" y="0" width="280" height="42" rx="21" fill="url(#pillBg)" stroke="url(#pillStroke)" stroke-width="1.2"/>
    <text x="140" y="27" text-anchor="middle" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="13" font-weight="600" letter-spacing="1.5" fill="#d4af37">
      AUTONOMOUS AGENTS
    </text>
    <rect x="310" y="0" width="310" height="42" rx="21" fill="url(#pillBg)" stroke="url(#pillStroke)" stroke-width="1.2"/>
    <text x="465" y="27" text-anchor="middle" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="13" font-weight="600" letter-spacing="1.5" fill="#f5f5f7">
      WINDOWS 11 NATIVE CLIENT
    </text>
  </g>
  <text x="540" y="995" text-anchor="middle" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="13" font-weight="600" letter-spacing="3" fill="#71717a">
    MICROSOFT STORE 1:1 SQUARE MASTER • 1080P
  </text>
</svg>"""

# =========================================================================
# 16:9 Super Hero Art (1920x1080 and 3840x2160)
# =========================================================================
def build_superhero_16x9_stacked(render_w, render_h, title_p1="Signal", title_p2="REACH", subtitle="DESKTOP WORKSPACE FOR AI AGENTS"):
    """
    Generates 16:9 Super Hero Art for Microsoft Store (viewBox 0 0 1920 1080).
    Renders at 1920x1080 (1080p FHD standard) or 3840x2160 (4K UHD master).
    """
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width="{render_w}" height="{render_h}">
  <defs>{EMBLEM_DEFS}</defs>
  <rect width="1920" height="1080" fill="url(#heroBgGrad)"/>
  <rect x="28" y="28" width="1864" height="1024" rx="30" fill="none" stroke="url(#borderGrad)" stroke-width="1.6"/>
  <text x="960" y="165" text-anchor="middle" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="16" font-weight="700" letter-spacing="6" fill="#d4af37">
    AUTONOMOUS WORKSPACE
  </text>
  <path d="M840 190 L1080 190" stroke="url(#borderGrad)" stroke-width="1.2"/>
  <circle cx="960" cy="380" r="440" fill="url(#heroCoreGlow)"/>
  <g transform="translate(960, 380) scale(0.88) translate(-256, -256)">
{RAW_EMBLEM}
  </g>
  <text x="960" y="670" text-anchor="middle" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="94" font-weight="750" letter-spacing="-1.5">
    <tspan fill="#f5f5f7">{title_p1}</tspan><tspan fill="#d4af37">{title_p2}</tspan>
  </text>
  <text x="960" y="740" text-anchor="middle" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="26" font-weight="500" letter-spacing="6" fill="#a1a1aa">
    {subtitle}
  </text>
  <path d="M720 785 L1200 785" stroke="url(#borderGrad)" stroke-width="1.2"/>
  <g transform="translate(420, 825)">
    <rect x="0" y="0" width="320" height="48" rx="24" fill="url(#pillBg)" stroke="url(#pillStroke)" stroke-width="1.2"/>
    <text x="160" y="30" text-anchor="middle" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="14" font-weight="600" letter-spacing="1.5" fill="#d4af37">
      AUTONOMOUS AGENTS
    </text>
    <rect x="350" y="0" width="380" height="48" rx="24" fill="url(#pillBg)" stroke="url(#pillStroke)" stroke-width="1.2"/>
    <text x="540" y="30" text-anchor="middle" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="14" font-weight="600" letter-spacing="1.5" fill="#f5f5f7">
      INTEGRATED BROWSER &amp; CODE
    </text>
    <rect x="760" y="0" width="320" height="48" rx="24" fill="url(#pillBg)" stroke="url(#pillStroke)" stroke-width="1.2"/>
    <text x="920" y="30" text-anchor="middle" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="14" font-weight="600" letter-spacing="1.5" fill="#d4af37">
      WINDOWS 11 NATIVE CLIENT
    </text>
  </g>
  <text x="960" y="990" text-anchor="middle" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="14" font-weight="600" letter-spacing="3.5" fill="#71717a">
    MICROSOFT STORE 16:9 SUPER HERO ART
  </text>
</svg>"""

def build_superhero_16x9_wide(render_w, render_h):
    """
    Generates 16:9 Super Hero Art cinematic horizontal lockup (viewBox 0 0 1920 1080).
    """
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width="{render_w}" height="{render_h}">
  <defs>{EMBLEM_DEFS}</defs>
  <rect width="1920" height="1080" fill="url(#heroBgGrad)"/>
  <rect x="28" y="28" width="1864" height="1024" rx="30" fill="none" stroke="url(#borderGrad)" stroke-width="1.6"/>
  <circle cx="560" cy="540" r="460" fill="url(#heroCoreGlow)"/>
  <g transform="translate(560, 540) scale(0.92) translate(-256, -256)">
{RAW_EMBLEM}
  </g>
  <g transform="translate(820, 0)">
    <text x="0" y="440" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="16" font-weight="700" letter-spacing="5" fill="#d4af37">
      AUTONOMOUS AGENT WORKSPACE
    </text>
    <path d="M0 460 L320 460" stroke="url(#borderGrad)" stroke-width="1.2"/>
    <text x="0" y="555" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="105" font-weight="750" letter-spacing="-1.8">
      <tspan fill="#f5f5f7">Signal</tspan><tspan fill="#d4af37">REACH</tspan>
    </text>
    <text x="0" y="625" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="30" font-weight="500" letter-spacing="2.5" fill="#d4d4d8">
      Desktop Workspace for AI Agents
    </text>
    <text x="0" y="675" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="20" font-weight="400" letter-spacing="1" fill="#a1a1aa">
      Autonomous Teams • Browser Automation • Code &amp; Terminals
    </text>
    <path d="M0 715 L660 715" stroke="url(#borderGrad)" stroke-width="1.5"/>
    <text x="0" y="755" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="15" font-weight="600" letter-spacing="2" fill="#d4af37">
      MICROSOFT STORE SUPER HERO ART • 16:9 WIDESCREEN
    </text>
  </g>
</svg>"""

def build_superhero_16x9_emblem(render_w, render_h):
    """
    Generates 16:9 Super Hero Art pure glowing emblem master (viewBox 0 0 1920 1080).
    """
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width="{render_w}" height="{render_h}">
  <defs>{EMBLEM_DEFS}</defs>
  <rect width="1920" height="1080" fill="url(#heroBgGrad)"/>
  <rect x="28" y="28" width="1864" height="1024" rx="30" fill="none" stroke="url(#borderGrad)" stroke-width="1.6"/>
  <circle cx="960" cy="540" r="540" fill="url(#heroCoreGlow)"/>
  <g transform="translate(960, 540) scale(1.35) translate(-256, -256)">
{RAW_EMBLEM}
  </g>
</svg>"""

def build_hero_1280x720_stacked(title_p1="Signal", title_p2="REACH", subtitle="DESKTOP WORKSPACE FOR AI AGENTS"):
    """Generates 1280x720 standard 720p 16:9 Microsoft Store Promotional Hero Banner (Stacked)."""
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="1280" height="720">
  <defs>{EMBLEM_DEFS}</defs>
  <rect width="1280" height="720" fill="url(#heroBgGrad)"/>
  <rect x="18" y="18" width="1244" height="684" rx="20" fill="none" stroke="url(#borderGrad)" stroke-width="1.2"/>
  <circle cx="640" cy="235" r="320" fill="url(#heroCoreGlow)"/>
  <g transform="translate(640, 230) scale(0.55) translate(-256, -256)">
{RAW_EMBLEM}
  </g>
  <text x="640" y="420" text-anchor="middle" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="64" font-weight="700" letter-spacing="-1">
    <tspan fill="#f5f5f7">{title_p1}</tspan><tspan fill="#d4af37">{title_p2}</tspan>
  </text>
  <text x="640" y="470" text-anchor="middle" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="19" font-weight="500" letter-spacing="4.5" fill="#a1a1aa">
    {subtitle}
  </text>
  <g transform="translate(325, 520)">
    <rect x="0" y="0" width="180" height="34" rx="17" fill="url(#pillBg)" stroke="url(#pillStroke)" stroke-width="1"/>
    <text x="90" y="22" text-anchor="middle" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="12" font-weight="600" letter-spacing="1" fill="#d4af37">AUTONOMOUS AGENTS</text>
    <rect x="210" y="0" width="190" height="34" rx="17" fill="url(#pillBg)" stroke="url(#pillStroke)" stroke-width="1"/>
    <text x="305" y="22" text-anchor="middle" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="12" font-weight="600" letter-spacing="1" fill="#f5f5f7">WINDOWS 11 NATIVE</text>
    <rect x="430" y="0" width="200" height="34" rx="17" fill="url(#pillBg)" stroke="url(#pillStroke)" stroke-width="1"/>
    <text x="530" y="22" text-anchor="middle" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="12" font-weight="600" letter-spacing="1" fill="#d4af37">LOCAL &amp; CLOUD MODELS</text>
  </g>
</svg>"""

def build_hero_1280x720_wide():
    """Generates 1280x720 horizontal cinematic brand banner."""
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="1280" height="720">
  <defs>{EMBLEM_DEFS}</defs>
  <rect width="1280" height="720" fill="url(#heroBgGrad)"/>
  <rect x="18" y="18" width="1244" height="684" rx="20" fill="none" stroke="url(#borderGrad)" stroke-width="1.2"/>
  <circle cx="380" cy="360" r="300" fill="url(#heroCoreGlow)"/>
  <g transform="translate(380, 360) scale(0.58) translate(-256, -256)">
{RAW_EMBLEM}
  </g>
  <g transform="translate(540, 0)">
    <text x="0" y="335" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="74" font-weight="750" letter-spacing="-1.2">
      <tspan fill="#f5f5f7">Signal</tspan><tspan fill="#d4af37">REACH</tspan>
    </text>
    <text x="0" y="385" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="22" font-weight="500" letter-spacing="2" fill="#d4d4d8">
      Desktop Workspace for AI Agents
    </text>
    <text x="0" y="425" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="15" font-weight="400" letter-spacing="0.8" fill="#a1a1aa">
      Autonomous Teams • Browser Automation • Code &amp; Terminals
    </text>
    <path d="M0 455 L460 455" stroke="url(#borderGrad)" stroke-width="1.5"/>
    <text x="0" y="485" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="13" font-weight="600" letter-spacing="1.5" fill="#d4af37">
      MICROSOFT STORE PUBLISHING EDITION • 720P HD
    </text>
  </g>
</svg>"""

def build_hero_1280x720_emblem():
    """Generates 1280x720 emblem-focused promotional art."""
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="1280" height="720">
  <defs>{EMBLEM_DEFS}</defs>
  <rect width="1280" height="720" fill="url(#heroBgGrad)"/>
  <rect x="18" y="18" width="1244" height="684" rx="20" fill="none" stroke="url(#borderGrad)" stroke-width="1.2"/>
  <circle cx="640" cy="360" r="360" fill="url(#heroCoreGlow)"/>
  <g transform="translate(640, 360) scale(0.85) translate(-256, -256)">
{RAW_EMBLEM}
  </g>
</svg>"""

def build_hero_1280x720_transparent():
    """Generates 1280x720 transparent brand lockup."""
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="1280" height="720">
  <defs>{EMBLEM_DEFS}</defs>
  <circle cx="640" cy="235" r="320" fill="url(#heroCoreGlow)"/>
  <g transform="translate(640, 230) scale(0.55) translate(-256, -256)">
{RAW_EMBLEM}
  </g>
  <text x="640" y="420" text-anchor="middle" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="64" font-weight="700" letter-spacing="-1">
    <tspan fill="#f5f5f7">Signal</tspan><tspan fill="#d4af37">REACH</tspan>
  </text>
  <text x="640" y="470" text-anchor="middle" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="19" font-weight="500" letter-spacing="4.5" fill="#a1a1aa">
    DESKTOP WORKSPACE FOR AI AGENTS
  </text>
</svg>"""

def build_poster_2x3_svg(render_w, render_h, title_p1="Signal", title_p2="REACH", subtitle="DESKTOP WORKSPACE FOR AI AGENTS"):
    """
    Generates 2:3 vertical poster art for Microsoft Store (viewBox 0 0 720 1080).
    Renders sharply at 720x1080 (1x) or 1440x2160 (2x high-res).
    """
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 1080" width="{render_w}" height="{render_h}">
  <defs>{EMBLEM_DEFS}</defs>
  <rect width="720" height="1080" fill="url(#posterBgGrad)"/>
  <rect x="22" y="22" width="676" height="1036" rx="24" fill="none" stroke="url(#borderGrad)" stroke-width="1.4"/>
  <text x="360" y="115" text-anchor="middle" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="13" font-weight="700" letter-spacing="4.5" fill="#d4af37">
    AUTONOMOUS WORKSPACE
  </text>
  <path d="M300 135 L420 135" stroke="url(#borderGrad)" stroke-width="1"/>
  <circle cx="360" cy="390" r="330" fill="url(#heroCoreGlow)"/>
  <g transform="translate(360, 390) scale(0.68) translate(-256, -256)">
{RAW_EMBLEM}
  </g>
  <text x="360" y="620" text-anchor="middle" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="64" font-weight="750" letter-spacing="-1">
    <tspan fill="#f5f5f7">{title_p1}</tspan><tspan fill="#d4af37">{title_p2}</tspan>
  </text>
  <text x="360" y="670" text-anchor="middle" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="17" font-weight="500" letter-spacing="4" fill="#a1a1aa">
    {subtitle}
  </text>
  <path d="M240 710 L480 710" stroke="url(#borderGrad)" stroke-width="1.2"/>
  <g transform="translate(200, 745)">
    <rect x="0" y="0" width="320" height="42" rx="21" fill="url(#pillBg)" stroke="url(#pillStroke)" stroke-width="1.2"/>
    <text x="160" y="27" text-anchor="middle" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="13" font-weight="600" letter-spacing="2" fill="#d4af37">
      AUTONOMOUS AGENT TEAMS
    </text>
    <rect x="0" y="58" width="320" height="42" rx="21" fill="url(#pillBg)" stroke="url(#pillStroke)" stroke-width="1.2"/>
    <text x="160" y="85" text-anchor="middle" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="13" font-weight="600" letter-spacing="2" fill="#f5f5f7">
      INTEGRATED BROWSER &amp; CODE
    </text>
    <rect x="0" y="116" width="320" height="42" rx="21" fill="url(#pillBg)" stroke="url(#pillStroke)" stroke-width="1.2"/>
    <text x="160" y="143" text-anchor="middle" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="13" font-weight="600" letter-spacing="2" fill="#d4af37">
      LOCAL &amp; CLOUD ORCHESTRATION
    </text>
  </g>
  <text x="360" y="990" text-anchor="middle" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="12" font-weight="600" letter-spacing="2.5" fill="#71717a">
    MICROSOFT STORE POSTER ART • WINDOWS 11
  </text>
</svg>"""

def build_poster_9x16_svg(render_w, render_h, title_p1="Signal", title_p2="REACH", subtitle="DESKTOP WORKSPACE FOR AI AGENTS"):
    """
    Generates 9:16 vertical poster art (viewBox 0 0 720 1280).
    Renders at 720x1280 or 1080x1920.
    """
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 1280" width="{render_w}" height="{render_h}">
  <defs>{EMBLEM_DEFS}</defs>
  <rect width="720" height="1280" fill="url(#posterBgGrad)"/>
  <rect x="22" y="22" width="676" height="1236" rx="26" fill="none" stroke="url(#borderGrad)" stroke-width="1.4"/>
  <text x="360" y="140" text-anchor="middle" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="14" font-weight="700" letter-spacing="5" fill="#d4af37">
    AUTONOMOUS WORKSPACE
  </text>
  <path d="M280 162 L440 162" stroke="url(#borderGrad)" stroke-width="1"/>
  <circle cx="360" cy="460" r="350" fill="url(#heroCoreGlow)"/>
  <g transform="translate(360, 460) scale(0.74) translate(-256, -256)">
{RAW_EMBLEM}
  </g>
  <text x="360" y="730" text-anchor="middle" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="68" font-weight="750" letter-spacing="-1.2">
    <tspan fill="#f5f5f7">{title_p1}</tspan><tspan fill="#d4af37">{title_p2}</tspan>
  </text>
  <text x="360" y="785" text-anchor="middle" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="18" font-weight="500" letter-spacing="4.5" fill="#a1a1aa">
    {subtitle}
  </text>
  <path d="M220 830 L500 830" stroke="url(#borderGrad)" stroke-width="1.2"/>
  <g transform="translate(190, 875)">
    <rect x="0" y="0" width="340" height="46" rx="23" fill="url(#pillBg)" stroke="url(#pillStroke)" stroke-width="1.2"/>
    <text x="170" y="29" text-anchor="middle" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="13" font-weight="600" letter-spacing="2" fill="#d4af37">
      AUTONOMOUS AGENT TEAMS
    </text>
    <rect x="0" y="62" width="340" height="46" rx="23" fill="url(#pillBg)" stroke="url(#pillStroke)" stroke-width="1.2"/>
    <text x="170" y="91" text-anchor="middle" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="13" font-weight="600" letter-spacing="2" fill="#f5f5f7">
      INTEGRATED BROWSER &amp; CODE
    </text>
    <rect x="0" y="124" width="340" height="46" rx="23" fill="url(#pillBg)" stroke="url(#pillStroke)" stroke-width="1.2"/>
    <text x="170" y="153" text-anchor="middle" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="13" font-weight="600" letter-spacing="2" fill="#d4af37">
      WINDOWS 11 NATIVE CLIENT
    </text>
  </g>
  <text x="360" y="1175" text-anchor="middle" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, sans-serif" font-size="12" font-weight="600" letter-spacing="3" fill="#71717a">
    MICROSOFT STORE 9:16 POSTER ART
  </text>
</svg>"""

def build_tile_svg(size, bg_squircle=True):
    """Generates square tile SVG of arbitrary size."""
    if bg_squircle:
        return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="{size}" height="{size}">
  <defs>{EMBLEM_DEFS}</defs>
  <rect x="20" y="20" width="472" height="472" rx="112" fill="url(#sqBgGrad)" stroke="url(#rimGrad)" stroke-width="3"/>
  <rect x="23" y="23" width="466" height="466" rx="109" fill="none" stroke="url(#innerRim)" stroke-width="1.5"/>
  <circle cx="256" cy="256" r="190" fill="url(#heroCoreGlow)"/>
{RAW_EMBLEM}
</svg>"""
    else:
        return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="{size}" height="{size}">
  <defs>{EMBLEM_DEFS}</defs>
  <circle cx="256" cy="256" r="190" fill="url(#heroCoreGlow)"/>
{RAW_EMBLEM}
</svg>"""

def build_wide_tile_svg(w, h):
    """Generates Wide 310x150 tile SVG."""
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">
  <defs>{EMBLEM_DEFS}</defs>
  <rect width="{w}" height="{h}" fill="url(#heroBgGrad)"/>
  <rect x="2" y="2" width="{w-4}" height="{h-4}" rx="8" fill="none" stroke="url(#borderGrad)" stroke-width="1"/>
  <circle cx="{h // 2}" cy="{h // 2}" r="{h // 2}" fill="url(#heroCoreGlow)"/>
  <g transform="translate({h // 2}, {h // 2}) scale(0.24) translate(-256, -256)">
{RAW_EMBLEM}
  </g>
  <text x="{h + 10}" y="{h // 2 + 7}" font-family="'Segoe UI', sans-serif" font-size="28" font-weight="700">
    <tspan fill="#f5f5f7">Signal</tspan><tspan fill="#d4af37">REACH</tspan>
  </text>
</svg>"""

def build_splash_svg(w, h):
    """Generates 620x300 SplashScreen SVG."""
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">
  <defs>{EMBLEM_DEFS}</defs>
  <rect width="{w}" height="{h}" fill="url(#heroBgGrad)"/>
  <circle cx="{w // 2}" cy="{h // 2 - 20}" r="140" fill="url(#heroCoreGlow)"/>
  <g transform="translate({w // 2}, {h // 2 - 20}) scale(0.36) translate(-256, -256)">
{RAW_EMBLEM}
  </g>
  <text x="{w // 2}" y="{h // 2 + 75}" text-anchor="middle" font-family="'Segoe UI', sans-serif" font-size="26" font-weight="700">
    <tspan fill="#f5f5f7">Signal</tspan><tspan fill="#d4af37">REACH</tspan>
  </text>
</svg>"""

def write_readme(dest_dir):
    readme_path = dest_dir / "README.md"
    readme_content = """# Microsoft Publishing Brand Assets

This directory contains Microsoft Store & Partner Center image assets generated specifically for **SignalR.E.A.C.H** / **Reach Studio** submissions.

## 1. 16:9 Super Hero Art (1920 x 1080 & 3840 x 2160)
Used for Microsoft Partner Center Store Listings under **Super hero art** placements (hero spotlight, widescreen storefront showcase, 4K displays).

| Filename | Resolution | Aspect Ratio | Target Placement |
|:---|:---|:---|:---|
| `microsoft-store-superhero-1920x1080.png` | **1920 × 1080** | **16:9** | **Super Hero Art (1080p FHD Standard)** — Primary widescreen hero with glowing emblem, wordmark, tagline, and badges. |
| `microsoft-store-superhero-3840x2160.png` | **3840 × 2160** | **16:9** | **Super Hero Art (4K UHD Master)** — Ultra high-definition master for 4K and scale-200 displays. |
| `microsoft-store-superhero-wide-1920x1080.png` | **1920 × 1080** | **16:9** | **Cinematic Horizontal Super Hero (1080p)** — Side-by-side emblem and typographic lockup. |
| `microsoft-store-superhero-wide-3840x2160.png` | **3840 × 2160** | **16:9** | **Cinematic Horizontal Super Hero (4K)** — 4K horizontal showcase banner. |
| `microsoft-store-superhero-reachstudio-1920x1080.png` | **1920 × 1080** | **16:9** | **Reach Studio Edition (1080p)** — Tailored for listings titled "Reach Studio". |
| `microsoft-store-superhero-reachstudio-3840x2160.png` | **3840 × 2160** | **16:9** | **Reach Studio Edition (4K)** — 4K edition for "Reach Studio". |
| `microsoft-store-superhero-emblem-1920x1080.png` | **1920 × 1080** | **16:9** | **Emblem Only Super Hero (1080p)** — Large centered emblem without text. |
| `microsoft-store-superhero-emblem-3840x2160.png` | **3840 × 2160** | **16:9** | **Emblem Only Super Hero (4K)** — 4K large centered emblem without text. |

*Also aliased as `16-9-Super-hero-art-1920x1080.png` and `16-9-Super-hero-art-3840x2160.png` for instant drag-and-drop identification.*

## 2. Store Display Images (Exact Partner Center Upload Slots)
Under **Store listings** → **Store display images**:

| Filename | Resolution | Ratio | Target Partner Center Slot |
|:---|:---|:---|:---|
| `AppTileIcon-300x300.png` | **300 × 300** | **1:1** | **1:1 App tile icon (300 × 300)** — Displayed in Store for Windows 10/11 customers (Fluent squircle). |
| `AppTileIcon-300x300-transparent.png` | **300 × 300** | **1:1** | **1:1 App tile icon (300 × 300)** — Transparent variant. |
| `StoreTile-150x150.png` | **150 × 150** | **1:1** | **1:1 (150 × 150)** — Medium store tile icon (Fluent squircle). |
| `StoreTile-150x150-transparent.png` | **150 × 150** | **1:1** | **1:1 (150 × 150)** — Transparent variant. |
| `StoreTile-71x71.png` | **71 × 71** | **1:1** | **1:1 (71 × 71)** — Small store tile icon (Fluent squircle). |
| `StoreTile-71x71-transparent.png` | **71 × 71** | **1:1** | **1:1 (71 × 71)** — Transparent variant. |

*Also aliased as `1-1-App-tile-icon-300x300.png`, `1-1-tile-150x150.png`, and `1-1-tile-71x71.png` for instant drag-and-drop identification.*

## 3. 1:1 Square Logos & Cards (1080p & 720p)
Used for high-resolution store branding, app icons, and square promotional banners.

| Filename | Resolution | Ratio | Target Microsoft Store Placement |
|:---|:---|:---|:---|
| `microsoft-store-logo-1080x1080.png` | **1080 × 1080** | **1:1** | **Master Fluent App Icon (1080p)** — Windows 11 Fluent squircle container, metallic gold rim, and centered emblem on deep graphite. |
| `microsoft-store-logo-1080x1080-transparent.png` | **1080 × 1080** | **1:1** | **Master Transparent Icon (1080p)** — High-res emblem with drop shadow and transparent background. |
| `microsoft-store-square-card-1080x1080.png` | **1080 × 1080** | **1:1** | **Square Showcase Card (1080p)** — 1:1 promotional banner featuring centered emblem, wordmark, tagline, and badges. |
| `microsoft-store-square-card-reachstudio-1080x1080.png` | **1080 × 1080** | **1:1** | **Reach Studio Square Card (1080p)** — Reach Studio 1:1 promotional card. |
| `microsoft-store-logo-720x720.png` | **720 × 720** | **1:1** | **Standard Fluent App Icon (720p)** — Windows 11 Fluent squircle container at 720p. |
| `microsoft-store-logo-720x720-transparent.png` | **720 × 720** | **1:1** | **Standard Transparent Icon (720p)** — Transparent square emblem at 720p. |

## 4. Vertical Poster Art (2:3 & 9:16 Aspect Ratios)
Used for Microsoft Partner Center Store Listings under **Poster art** placements (featured cards, vertical store collections, mobile/Xbox carousels).

| Filename | Resolution | Ratio | Target Microsoft Store Placement |
|:---|:---|:---|:---|
| `microsoft-store-poster-720x1080.png` | **720 × 1080** | **2:3** | **Official Store Poster Art (1x)** — Primary vertical poster with glowing emblem, wordmark, tagline, and feature badges. |
| `microsoft-store-poster-1440x2160.png` | **1440 × 2160** | **2:3** | **Official Store Poster Art (2x High-Res)** — Ultra high-definition master for 4K / scale-200 displays. |
| `microsoft-store-poster-reachstudio-720x1080.png` | **720 × 1080** | **2:3** | **Reach Studio Edition (1x)** — Product edition tailored for "Reach Studio". |
| `microsoft-store-poster-reachstudio-1440x2160.png` | **1440 × 2160** | **2:3** | **Reach Studio Edition (2x High-Res)** — 2x scale for "Reach Studio". |
| `microsoft-store-poster-9x16-720x1280.png` | **720 × 1280** | **9:16** | **9:16 Portrait Poster Art (720p)** — Standard mobile / vertical display ratio. |
| `microsoft-store-poster-9x16-1080x1920.png` | **1080 × 1920** | **9:16** | **9:16 Portrait Poster Art (1080p FHD)** — Full HD portrait showcase format. |

## 5. 720p HD Promotional Artwork (1280 x 720) — 16:9 Aspect Ratio
Used for Microsoft Partner Center Store Listings under **Promotional artwork** and **Hero banner** placements.

| Filename | Resolution | Description & Target Placement |
|:---|:---|:---|
| `microsoft-store-hero-1280x720.png` | **1280 × 720** | **Primary Store Hero Banner** — Stacked lockup with glowing gold emblem, "SignalREACH" wordmark, tagline, and feature badges. |
| `microsoft-store-hero-wide-1280x720.png` | **1280 × 720** | **Cinematic Horizontal Hero Banner** — Side-by-side emblem and typographic lockup for wide showcase placements. |
| `microsoft-store-hero-reachstudio-1280x720.png` | **1280 × 720** | **Reach Studio Edition** — Tailored for listings using the exact product name "Reach Studio". |
| `microsoft-store-hero-emblem-1280x720.png` | **1280 × 720** | **Emblem Only Hero** — Large centered glowing emblem on dark graphite canvas without typography. |
| `microsoft-store-hero-transparent-1280x720.png` | **1280 × 720** | **Transparent Hero Lockup** — Full alpha transparency for custom store overlays or compositing. |

## 6. Windows AppX / MSIX Package Tile Assets
Standard tile sizes for Windows app packaging (MSIX / AppxManifest visual assets):

| Filename | Resolution | Usage |
|:---|:---|:---|
| `Square44x44Logo.png` | 44 × 44 | Taskbar & Start Menu small icon |
| `Square150x150Logo.png` | 150 × 150 | Medium Start tile |
| `Square310x310Logo.png` | 310 × 310 | Large Start tile |
| `Wide310x150Logo.png` | 310 × 150 | Wide Start tile |
| `StoreLogo.png` | 50 × 50 | Legacy store logo tile |
| `SplashScreen.png` | 620 × 300 | App launch splash screen |

---

### Microsoft Store Visual Guidelines Compliance
- **Safe Zone:** All logos and typography are centered within the inner 80% safe zone, ensuring store UI elements, price tags, and device corners never obscure branding.
- **Color Fidelity:** Uses the signature SignalREACH graphite `#161619` and gold metallic `#d4af37` gradient palette.
- **Windows Fluent Design:** Aligns with Windows 11 typography (`Segoe UI`), lighting elevation, and squircle border geometry.
"""
    readme_path.write_text(readme_content, encoding='utf-8')
    print(f"  [OK] Wrote {readme_path.name}")

def main():
    print("=" * 70)
    print("Generating Microsoft Publishing Assets (Super Hero Art, Posters, Suite)")
    print("=" * 70)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # 1. 16:9 Super Hero Art (1920x1080 & 3840x2160)
    print("\n1. Generating 16:9 Super Hero Art (1920x1080 & 3840x2160):")
    # Stacked primary
    render_svg_to_png(build_superhero_16x9_stacked(1920, 1080, "Signal", "REACH"), OUTPUT_DIR / "microsoft-store-superhero-1920x1080.png", 1920, 1080)
    render_svg_to_png(build_superhero_16x9_stacked(3840, 2160, "Signal", "REACH"), OUTPUT_DIR / "microsoft-store-superhero-3840x2160.png", 3840, 2160)
    shutil.copy(OUTPUT_DIR / "microsoft-store-superhero-1920x1080.png", OUTPUT_DIR / "16-9-Super-hero-art-1920x1080.png")
    shutil.copy(OUTPUT_DIR / "microsoft-store-superhero-3840x2160.png", OUTPUT_DIR / "16-9-Super-hero-art-3840x2160.png")
    shutil.copy(OUTPUT_DIR / "microsoft-store-superhero-1920x1080.png", STUDIO_ASSETS_DIR / "microsoft-store-superhero-1920x1080.png")
    shutil.copy(OUTPUT_DIR / "microsoft-store-superhero-3840x2160.png", STUDIO_ASSETS_DIR / "microsoft-store-superhero-3840x2160.png")

    # Wide horizontal
    render_svg_to_png(build_superhero_16x9_wide(1920, 1080), OUTPUT_DIR / "microsoft-store-superhero-wide-1920x1080.png", 1920, 1080)
    render_svg_to_png(build_superhero_16x9_wide(3840, 2160), OUTPUT_DIR / "microsoft-store-superhero-wide-3840x2160.png", 3840, 2160)

    # Reach Studio edition
    render_svg_to_png(build_superhero_16x9_stacked(1920, 1080, "Reach ", "Studio", "AUTONOMOUS WORKSPACE FOR AI AGENTS"), OUTPUT_DIR / "microsoft-store-superhero-reachstudio-1920x1080.png", 1920, 1080)
    render_svg_to_png(build_superhero_16x9_stacked(3840, 2160, "Reach ", "Studio", "AUTONOMOUS WORKSPACE FOR AI AGENTS"), OUTPUT_DIR / "microsoft-store-superhero-reachstudio-3840x2160.png", 3840, 2160)

    # Emblem only
    render_svg_to_png(build_superhero_16x9_emblem(1920, 1080), OUTPUT_DIR / "microsoft-store-superhero-emblem-1920x1080.png", 1920, 1080)
    render_svg_to_png(build_superhero_16x9_emblem(3840, 2160), OUTPUT_DIR / "microsoft-store-superhero-emblem-3840x2160.png", 3840, 2160)

    # 2. Store Display Images (300x300, 150x150, 71x71)
    print("\n2. Generating Store Display Images (300x300, 150x150, 71x71):")
    render_svg_to_png(build_square_logo(300), OUTPUT_DIR / "AppTileIcon-300x300.png", 300, 300, transparent=True)
    render_svg_to_png(build_square_logo_transparent(300), OUTPUT_DIR / "AppTileIcon-300x300-transparent.png", 300, 300, transparent=True)
    shutil.copy(OUTPUT_DIR / "AppTileIcon-300x300.png", OUTPUT_DIR / "1-1-App-tile-icon-300x300.png")
    shutil.copy(OUTPUT_DIR / "AppTileIcon-300x300-transparent.png", OUTPUT_DIR / "1-1-App-tile-icon-300x300-transparent.png")
    shutil.copy(OUTPUT_DIR / "AppTileIcon-300x300.png", STUDIO_ASSETS_DIR / "AppTileIcon-300x300.png")

    render_svg_to_png(build_square_logo(150), OUTPUT_DIR / "StoreTile-150x150.png", 150, 150, transparent=True)
    render_svg_to_png(build_square_logo_transparent(150), OUTPUT_DIR / "StoreTile-150x150-transparent.png", 150, 150, transparent=True)
    shutil.copy(OUTPUT_DIR / "StoreTile-150x150.png", OUTPUT_DIR / "1-1-tile-150x150.png")
    shutil.copy(OUTPUT_DIR / "StoreTile-150x150-transparent.png", OUTPUT_DIR / "1-1-tile-150x150-transparent.png")
    shutil.copy(OUTPUT_DIR / "StoreTile-150x150.png", STUDIO_ASSETS_DIR / "StoreTile-150x150.png")

    render_svg_to_png(build_square_logo(71), OUTPUT_DIR / "StoreTile-71x71.png", 71, 71, transparent=True)
    render_svg_to_png(build_square_logo_transparent(71), OUTPUT_DIR / "StoreTile-71x71-transparent.png", 71, 71, transparent=True)
    shutil.copy(OUTPUT_DIR / "StoreTile-71x71.png", OUTPUT_DIR / "1-1-tile-71x71.png")
    shutil.copy(OUTPUT_DIR / "StoreTile-71x71-transparent.png", OUTPUT_DIR / "1-1-tile-71x71-transparent.png")
    shutil.copy(OUTPUT_DIR / "StoreTile-71x71.png", STUDIO_ASSETS_DIR / "StoreTile-71x71.png")

    # 3. 1:1 Square Logos & Cards (1080p & 720p)
    print("\n3. Generating 1:1 Square Logos & Cards (1080p & 720p):")
    render_svg_to_png(build_square_logo(1080), OUTPUT_DIR / "microsoft-store-logo-1080x1080.png", 1080, 1080, transparent=True)
    render_svg_to_png(build_square_logo_transparent(1080), OUTPUT_DIR / "microsoft-store-logo-1080x1080-transparent.png", 1080, 1080, transparent=True)
    render_svg_to_png(build_square_card_1080_svg("Signal", "REACH"), OUTPUT_DIR / "microsoft-store-square-card-1080x1080.png", 1080, 1080)
    render_svg_to_png(build_square_card_1080_svg("Reach ", "Studio", "AUTONOMOUS WORKSPACE FOR AI AGENTS"), OUTPUT_DIR / "microsoft-store-square-card-reachstudio-1080x1080.png", 1080, 1080)

    render_svg_to_png(build_square_logo(1080), STUDIO_ASSETS_DIR / "microsoft-store-logo-1080x1080.png", 1080, 1080, transparent=True)
    render_svg_to_png(build_square_card_1080_svg("Signal", "REACH"), STUDIO_ASSETS_DIR / "microsoft-store-square-card-1080x1080.png", 1080, 1080)

    render_svg_to_png(build_square_logo(720), OUTPUT_DIR / "microsoft-store-logo-720x720.png", 720, 720, transparent=True)
    render_svg_to_png(build_square_logo_transparent(720), OUTPUT_DIR / "microsoft-store-logo-720x720-transparent.png", 720, 720, transparent=True)
    render_svg_to_png(build_square_logo(720), STUDIO_ASSETS_DIR / "microsoft-store-logo-720x720.png", 720, 720, transparent=True)

    # 4. 1280x720 Promotional Banners (720p 16:9 standard)
    print("\n4. Generating 1280x720 (720p 16:9) Hero & Promotional Banners:")
    render_svg_to_png(build_hero_1280x720_stacked("Signal", "REACH"), OUTPUT_DIR / "microsoft-store-hero-1280x720.png", 1280, 720)
    render_svg_to_png(build_hero_1280x720_wide(), OUTPUT_DIR / "microsoft-store-hero-wide-1280x720.png", 1280, 720)
    render_svg_to_png(build_hero_1280x720_stacked("Reach ", "Studio", "AUTONOMOUS WORKSPACE FOR AI AGENTS"), OUTPUT_DIR / "microsoft-store-hero-reachstudio-1280x720.png", 1280, 720)
    render_svg_to_png(build_hero_1280x720_emblem(), OUTPUT_DIR / "microsoft-store-hero-emblem-1280x720.png", 1280, 720)
    render_svg_to_png(build_hero_1280x720_transparent(), OUTPUT_DIR / "microsoft-store-hero-transparent-1280x720.png", 1280, 720, transparent=True)
    render_svg_to_png(build_hero_1280x720_stacked("Signal", "REACH"), STUDIO_ASSETS_DIR / "microsoft-store-hero-1280x720.png", 1280, 720)

    # 5. Vertical Poster Art (2:3 & 9:16)
    print("\n5. Generating Vertical Poster Art:")
    render_svg_to_png(build_poster_2x3_svg(720, 1080, "Signal", "REACH"), OUTPUT_DIR / "microsoft-store-poster-720x1080.png", 720, 1080)
    render_svg_to_png(build_poster_2x3_svg(1440, 2160, "Signal", "REACH"), OUTPUT_DIR / "microsoft-store-poster-1440x2160.png", 1440, 2160)
    render_svg_to_png(build_poster_2x3_svg(720, 1080, "Reach ", "Studio", "AUTONOMOUS WORKSPACE FOR AI AGENTS"), OUTPUT_DIR / "microsoft-store-poster-reachstudio-720x1080.png", 720, 1080)
    render_svg_to_png(build_poster_2x3_svg(1440, 2160, "Reach ", "Studio", "AUTONOMOUS WORKSPACE FOR AI AGENTS"), OUTPUT_DIR / "microsoft-store-poster-reachstudio-1440x2160.png", 1440, 2160)

    render_svg_to_png(build_poster_9x16_svg(720, 1280, "Signal", "REACH"), OUTPUT_DIR / "microsoft-store-poster-9x16-720x1280.png", 720, 1280)
    render_svg_to_png(build_poster_9x16_svg(1080, 1920, "Signal", "REACH"), OUTPUT_DIR / "microsoft-store-poster-9x16-1080x1920.png", 1080, 1920)

    # 6. Windows AppX / MSIX Package Tiles
    print("\n6. Generating Windows AppX / MSIX Visual Asset Tiles:")
    render_svg_to_png(build_tile_svg(44), OUTPUT_DIR / "Square44x44Logo.png", 44, 44, transparent=True)
    render_svg_to_png(build_tile_svg(150), OUTPUT_DIR / "Square150x150Logo.png", 150, 150, transparent=True)
    render_svg_to_png(build_tile_svg(310), OUTPUT_DIR / "Square310x310Logo.png", 310, 310, transparent=True)
    render_svg_to_png(build_wide_tile_svg(310, 150), OUTPUT_DIR / "Wide310x150Logo.png", 310, 150)
    render_svg_to_png(build_tile_svg(50), OUTPUT_DIR / "StoreLogo.png", 50, 50, transparent=True)
    render_svg_to_png(build_splash_svg(620, 300), OUTPUT_DIR / "SplashScreen.png", 620, 300)

    # 7. Write Documentation
    print("\n7. Writing Documentation:")
    write_readme(OUTPUT_DIR)

    print("\n" + "=" * 70)
    print("All assets successfully generated and verified!")
    print("=" * 70)

if __name__ == "__main__":
    main()
