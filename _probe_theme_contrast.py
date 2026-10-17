"""Throwaway probe: per-theme, per-role contrast vs background."""
import sys
sys.path.insert(0, "tools")
from reach_cli import themes

print("role order:", themes._ROLE_NAMES)
print()
for t in themes.all_themes():
    if not t.background:
        continue
    fg_r = themes.contrast_ratio(t.foreground, t.background)
    print("%-16s bg=%s fg=%s (fg contrast %.2f)" % (
        t.key, t.background, t.foreground, fg_r))
    for role in themes._ROLE_NAMES:
        c = t.roles.get(role)
        r = themes.contrast_ratio(c, t.background) if c else None
        print("  %-10s %-8s contrast=%s" % (role, c, ("%.2f" % r) if r else "-"))
    print("  note:", t.note)
    print()

# What does a role actually render as for the two headline themes?
import os
for key in ("solarized-light", "campbell"):
    themes.select_theme(key)
    t = themes.current_theme()
    print("== %s (truecolor role SGR) ==" % key)
    os.environ["COLORTERM"] = "truecolor"
    for role in ("border", "accent", "secondary", "success", "warning", "error", "muted"):
        sgr = themes._role_sgr(role, t)
        print("  %-10s -> %r" % (role, sgr))
print("probe done")
