"""Locate the user's Lemonade / SimpleTheme source on this machine.

Scans common terminal/editor config locations for 'lemonade' or 'simpletheme'
so the crew can pin the exact palette instead of inventing one.
"""

import glob
import os

home = os.path.expanduser("~")
roots = [
    os.path.join(home, ".config"),
    os.path.join(home, ".vscode"),
    os.path.join(home, ".wezterm.lua"),
    os.path.join(home, ".kitty.conf"),
    os.path.join(home, ".tmux.conf"),
    os.path.join(home, ".bashrc"),
    os.path.join(home, ".zshrc"),
    os.path.join(home, ".profile"),
    os.path.join(os.environ.get("APPDATA", ""), "Code", "User"),
    os.path.join(home, "AppData", "Local", "SignalREACH"),
    os.path.join(home, "AppData", "Roaming", "Microsoft", "Windows Terminal"),
]

needles = ("lemonade", "simpletheme", "simple theme")
hits = []
checked = 0

for root in roots:
    if not root or not os.path.exists(root):
        continue
    if os.path.isfile(root):
        files = [root]
    else:
        files = []
        patterns = (
            "**/*.json", "**/*.jsonc", "**/*.lua", "**/*.conf", "**/*.toml",
            "**/*.xml", "**/*.css", "**/*.js", "**/*.cjs", "**/*.mjs",
            "**/*.py", "**/*.sh", "**/*.ps1", "**/*.bashrc", "**/*.zshrc",
            "**/*.profile", "**/*bashrc", "**/*zshrc",
        )
        for pattern in patterns:
            files.extend(glob.glob(os.path.join(root, pattern), recursive=True))
    seen = set()
    for path in files:
        real = os.path.realpath(path)
        if real in seen or not os.path.isfile(real):
            continue
        seen.add(real)
        checked += 1
        try:
            if os.path.getsize(path) > 2_000_000:
                continue
            text = open(path, "r", encoding="utf-8", errors="ignore").read()
        except OSError:
            continue
        folded = text.casefold()
        for needle in needles:
            if needle in folded:
                hits.append((needle, path))
                break

print("files checked:", checked)
for needle, path in hits:
    print("HIT", needle, "->", path)
print("total hits:", len(hits))
