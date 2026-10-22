"""Render REACH Studio music-led ads with original procedural audio and motion graphics."""
from pathlib import Path
import json
import math
import subprocess
import wave

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'dist' / 'studio-ad'
FONT = Path('C:/Windows/Fonts/bahnschrift.ttf')
GOLD = '#e6c76b'
WHITE = '#f2efe6'
MUTED = '#b4b7bb'
SCENES = [
    ('01 / THE WORKSPACE', 'An idea deserves\na workspace.', 'Meet REACH Studio.', 'IDEA  /  PLAN  /  CREATE'),
    ('02 / YOUR MODELS', 'Choose the model.\nShape the work.', 'Connect your providers in one desktop workspace.', 'MODEL  /  CONNECTION  /  CONTEXT'),
    ('03 / YOUR AGENTS', 'Give your agents\na place to work.', 'Keep conversations, files and activity together.', 'PROMPT  /  FILES  /  ACTIVITY'),
    ('04 / YOUR TEAM', 'Build a team\naround the task.', 'Create agents with distinct roles. Bring them together.', 'PLAN  /  BUILD  /  REVIEW'),
    ('05 / YOUR CONTROL', 'See the work.\nReview the changes.', 'Inspect proposed edits before you accept them.', 'INSPECT  /  REVIEW  /  APPLY'),
    ('REACH STUDIO', 'Your ideas.\nWithin REACH.', 'Your models. Your agents. Your workspace.', 'EXPLORE REACH STUDIO'),
]


def soundtrack():
    sr = 48000
    t = np.arange(sr * 30) / sr
    audio = np.zeros_like(t)
    # Original 96 BPM instrumental: minor-ninth pads, a restrained arpeggio and drums.
    chords = [(45, 52, 57, 60, 64), (41, 48, 53, 57, 60), (48, 55, 60, 64, 67), (43, 50, 55, 59, 62)]
    rng = np.random.default_rng(42)
    for bar in range(12):
        start = bar * 2.5
        local = t - start
        mask = (local >= 0) & (local < 3.0)
        x = local[mask]
        env = np.minimum(x / .35, 1) * np.minimum((3 - x) / .7, 1)
        chord = chords[bar % 4]
        for midi in chord:
            f = 440 * 2 ** ((midi - 69) / 12)
            audio[mask] += .024 * env * (np.sin(2 * np.pi * f * x) + .25 * np.sin(2 * np.pi * f * 2.003 * x))
        for step in range(8):
            onset = start + step * .3125
            a = int(onset * sr)
            n = min(int(.5 * sr), len(audio) - a)
            x = np.arange(n) / sr
            f = 440 * 2 ** ((chord[step % len(chord)] + 12 - 69) / 12)
            audio[a:a+n] += .06 * np.sin(2 * np.pi * f * x) * np.exp(-x * 12) * np.minimum(x * 300, 1)
        for beat in range(4):
            a = int((start + beat * .625) * sr)
            n = min(int(.22 * sr), len(audio) - a)
            x = np.arange(n) / sr
            audio[a:a+n] += .15 * np.sin(2 * np.pi * (48 * x + 7 * (1 - np.exp(-x * 25)))) * np.exp(-x * 19)
            if beat % 2:
                audio[a:a+n] += .035 * rng.normal(size=n) * np.exp(-x * 40)
    audio *= np.minimum(t / 1.2, 1) * np.minimum((30 - t) / 1.8, 1)
    audio *= .78 / max(np.max(np.abs(audio)), .01)
    stereo = np.column_stack([audio, .94 * audio + .06 * np.roll(audio, 420)])
    with wave.open(str(OUT / 'original-score.wav'), 'wb') as stream:
        stream.setparams((2, 2, sr, 0, 'NONE', 'not compressed'))
        stream.writeframes((stereo * 32767).astype('<i2').tobytes())


def frame(t, width, height):
    scale = width / 1920
    portrait = height > width
    def f(size):
        return ImageFont.truetype(str(FONT), max(12, int(size * scale)))
    image = Image.new('RGB', (width, height), '#101419')
    d = ImageDraw.Draw(image)
    # A restrained architectural grid and moving gold signal lines.
    for x in range(0, width, max(1, int(96 * scale))):
        d.line((x, 0, x, height), fill='#1a2027')
    for y in range(0, height, max(1, int(96 * scale))):
        d.line((0, y, width, y), fill='#1a2027')
    margin = int(width * .075)
    d.text((margin, int(height * .055)), 'REACH', font=f(40 if not portrait else 58), fill=GOLD)
    d.text((margin + int(154 * scale if not portrait else 220 * scale), int(height * .055)), 'STUDIO', font=f(40 if not portrait else 58), fill=WHITE)
    index = min(int(t / 5), 5)
    local = t % 5
    ease = 1 - (1 - min(local / .75, 1)) ** 3
    offset = int((1 - ease) * 34 * scale)
    eyebrow, title, subtitle, tags = SCENES[index]
    top = int(height * (.20 if portrait else .245)) + offset
    d.text((margin, top), eyebrow, font=f(23 if not portrait else 34), fill=GOLD)
    title_size = 100 if not portrait else 124
    d.multiline_text((margin, top + int(62 * scale)), title, font=f(title_size), fill=WHITE, spacing=int(12 * scale))
    sub_y = top + int((320 if not portrait else 380) * scale)
    # Wrap to a measured safe area, never crop explanatory text.
    max_width = int(width * (.48 if not portrait else .83))
    lines, line = [], ''
    font = f(30 if not portrait else 43)
    for word in subtitle.split():
        candidate = (line + ' ' + word).strip()
        if d.textlength(candidate, font=font) > max_width and line:
            lines.append(line)
            line = word
        else:
            line = candidate
    lines.append(line)
    d.multiline_text((margin, sub_y), '\n'.join(lines), font=font, fill=MUTED, spacing=int(12 * scale))
    cx, cy = (int(width * .77), int(height * .49)) if not portrait else (width // 2, int(height * .69))
    radius = int(width * (.14 if not portrait else .20))
    d.ellipse((cx-radius, cy-radius, cx+radius, cy+radius), outline='#3e392b', width=max(1, int(2*scale)))
    nodes = []
    for i in range(4):
        angle = i * math.pi / 2 - math.pi / 2
        x, y = cx + math.cos(angle) * radius, cy + math.sin(angle) * radius
        nodes.append((x, y))
        d.line((cx, cy, x, y), fill='#75633d', width=max(1, int(3 * scale)))
        r = int(12 * scale)
        d.ellipse((x-r,y-r,x+r,y+r), fill=GOLD)
        phase = (local / 2 + i / 4) % 1
        px, py = cx + (x-cx)*phase, cy + (y-cy)*phase
        d.ellipse((px-r/3,py-r/3,px+r/3,py+r/3), fill=WHITE)
    d.line(nodes + [nodes[0]], fill=GOLD, width=max(2, int(4*scale)))
    r = int(65 * scale)
    d.rounded_rectangle((cx-r,cy-r,cx+r,cy+r), radius=int(18*scale), fill='#24251f', outline=GOLD, width=2)
    word = ['IDEA','MODEL','AGENT','TEAM','REVIEW','REACH'][index]
    wordfont = f(25)
    d.text((cx-d.textlength(word,font=wordfont)/2,cy-int(14*scale)), word, font=wordfont, fill=WHITE)
    d.text((margin, int(height * .87)), tags, font=f(22 if not portrait else 30), fill=GOLD)
    d.text((margin, int(height * .93)), 'REACH STUDIO  /  DESKTOP AI WORKSPACE', font=f(17 if not portrait else 23), fill=MUTED)
    d.rectangle((0,height-4,int(width*t/30),height),fill=GOLD)
    fade = min(local/.25, (5-local)/.25, 1)
    if fade < 1:
        image = Image.blend(Image.new('RGB', image.size, '#101419'), image, max(0,fade))
    return image


def render(name, width, height):
    command = ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
               '-s', f'{width}x{height}', '-r', '30', '-i', '-', '-i', str(OUT / 'original-score.wav'),
               '-c:v', 'libx264', '-preset', 'fast', '-crf', '19', '-pix_fmt', 'yuv420p',
               '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=9',
               '-movflags', '+faststart', '-t', '30', str(OUT / name)]
    process = subprocess.Popen(command, stdin=subprocess.PIPE)
    try:
        for n in range(900):
            process.stdin.write(frame(n/30, width, height).tobytes())
    finally:
        process.stdin.close()
    if process.wait():
        raise RuntimeError('FFmpeg render failed')


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    soundtrack()
    render('REACH-Studio-YouTube-1080p.mp4', 1920, 1080)
    render('REACH-Studio-X-4x5.mp4', 1080, 1350)
    frame(27, 1920, 1080).save(OUT / 'YouTube-thumbnail.png')
    sheet = Image.new('RGB', (960, 810))
    for i in range(6):
        shot = frame(i*5+2, 1920, 1080).resize((480,270))
        sheet.paste(shot, ((i%2)*480,(i//2)*270))
    sheet.save(OUT / 'storyboard.jpg')
    (OUT / 'production-notes.json').write_text(json.dumps({
        'duration_seconds': 30, 'fps': 30, 'visuals': 'Animated feature graphics, not product footage',
        'music': 'Original procedural instrumental generated by tools/build_studio_ad.py; no stock recording',
        'cta': 'Brand-only ending; download URL pending user confirmation',
        'scenes': SCENES,
    }, indent=2) + '\n')
    print('Rendered ads:', OUT)


if __name__ == '__main__':
    main()
