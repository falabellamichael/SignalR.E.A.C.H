"""Small, private, terminal-native companions for the fixed CLI header.

The animation clock is read on demand. Nothing here prints, starts a thread,
stores prompt text, or emits terminal controls; the screen owner paints frames.
"""
import math
import threading
import time


PET_NAMES = ("cat", "owl", "bulldog")
_NAMES = {"cat": "Cat", "owl": "Owl", "bulldog": "Micro bulldog"}
_ALIASES = {
    "cat": "cat", "kitty": "cat", "kitten": "cat",
    "owl": "owl", "owlet": "owl",
    "bulldog": "bulldog", "dog": "bulldog", "micro bulldog": "bulldog",
    "micro-bulldog": "bulldog", "micro_bulldog": "bulldog",
}
_STATUS = {
    "idle": "I'm ready",
    "typing": "I'm listening...",
    "waiting": "I'm working on it...",
    "thinking": "I'm thinking...",
    "responding": "I'm answering...",
    "searching": "I'm searching...",
    "reading": "I'm reading...",
    "writing": "I'm editing files...",
    "running": "I'm running a command...",
    "checking": "I'm checking...",
    "blocked": "I need your help",
    "complete": "I'm done!",
    "error": "I hit a snag",
    "cancelled": "I've stopped",
}
_ACTIVITIES = frozenset(_STATUS)
_BUSY_ACTIVITIES = frozenset((
    "waiting", "thinking", "responding", "searching", "reading", "writing",
    "running", "checking",
))
_TRANSIENTS = {"typing": 1.2, "complete": 3.2, "error": 2.4, "cancelled": 2.4}
_SPRITE_WIDTH = 10


def normalize_pet(value):
    """Return a supported species, or None for a misspelled selection."""
    return _ALIASES.get(str(value or "").strip().lower())


def activity_status(activity):
    """First-person, fixed UI labels; never use model text or tool arguments."""
    return _STATUS.get(str(activity or "idle"), _STATUS["idle"])


def _ease(value):
    value = max(0.0, min(1.0, value))
    return value * value * (3.0 - 2.0 * value)


def _animation(activity, elapsed):
    """Return behavior, normalized horizontal position, and facing direction."""
    if activity == "waiting":
        phase = elapsed % 14.0
        if phase < 1.0:
            return "curious", 0.0, 1
        if phase < 5.0:
            return "walking_to_bowl", _ease((phase - 1.0) / 4.0), 1
        if phase < 8.0:
            return "snacking", 1.0, 1
        if phase < 12.0:
            return "walking_back", 1.0 - _ease((phase - 8.0) / 4.0), -1
        return "resting", 0.0, -1
    if activity == "typing":
        return "typing", 0.12, 1
    if activity == "thinking":
        return "pondering", 0.12, 1
    if activity == "responding":
        return "speaking", 0.12, 1
    if activity in ("searching", "reading"):
        return activity, 0.12, 1
    if activity in ("writing", "running", "checking"):
        return "working", 0.12, 1
    if activity == "complete":
        return "celebrating", 0.35 + 0.06 * math.sin(elapsed * 5.0), 1
    if activity == "error":
        return "settling", 0.12, 1
    if activity in ("cancelled", "blocked"):
        return "resting", 0.12, 1
    phase = elapsed % 24.0
    if phase < 4.0:
        return "looking", 0.12, 1
    if phase < 7.0:
        return "grooming", 0.12, 1
    if phase < 9.0:
        return "stretching", 0.12, 1
    if phase < 13.0:
        return "sleeping", 0.12, 1
    if phase < 16.0:
        return "curious", 0.12, 1
    if phase < 20.0:
        return "strolling", 0.12 + 0.5 * _ease((phase - 16.0) / 4.0), 1
    return "strolling", 0.62 - 0.5 * _ease((phase - 20.0) / 4.0), -1


class TerminalPet:
    """Thread-safe activity state with deterministic, resize-safe animation."""

    def __init__(self, kind="cat", clock=None, motion=True):
        self._clock = clock if clock is not None else time.monotonic
        self._lock = threading.RLock()
        self._kind = normalize_pet(kind) or "cat"
        self._motion = bool(motion)
        self._activity = "idle"
        self._changed = float(self._clock())
        self._last_typed = None
        self._draft_length = 0

    def select(self, kind):
        selected = normalize_pet(kind)
        if selected is None:
            return False
        with self._lock:
            self._kind = selected
        return True

    def set_motion(self, enabled):
        with self._lock:
            self._motion = bool(enabled)

    def set_activity(self, activity):
        activity = str(activity or "idle").lower().strip()
        if activity not in _ACTIVITIES:
            raise ValueError("Unsupported pet activity: %s" % activity)
        with self._lock:
            self._set_activity(activity, float(self._clock()))

    def _state_at(self, now):
        activity = self._activity
        elapsed = max(0.0, now - self._changed)
        duration = _TRANSIENTS.get(activity)
        expiry_start = (self._last_typed if activity == "typing" and
                        self._last_typed is not None else self._changed)
        if duration is not None and now - expiry_start >= duration:
            return "idle", max(0.0, now - expiry_start - duration)
        return activity, elapsed

    def _set_activity(self, activity, now):
        current, _elapsed = self._state_at(now)
        # Keep animation phase across frequent keystrokes or stream updates.
        # An explicit new event after a transient expires starts a fresh phase.
        if activity != self._activity or current != activity:
            self._activity = activity
            self._changed = now
        if activity == "typing":
            self._last_typed = now

    def note_input(self, text):
        """React to a caller-reported draft change without keeping its text.

        Call this when the draft changes, not on paint or cursor movement. Even
        a same-length replacement is a typing event. An emptied composer leaves
        the response lifecycle alone, including its completion animation.
        """
        length = len(text) if text is not None else 0
        with self._lock:
            self._draft_length = length
            if length and self._activity not in _BUSY_ACTIVITIES:
                self._set_activity("typing", float(self._clock()))

    def snapshot(self):
        with self._lock:
            activity, elapsed = self._state_at(float(self._clock()))
            behavior, position, direction = _animation(activity, elapsed)
            frame = int((elapsed + 1e-9) / 0.16) % 8
            if not self._motion:
                behavior, position, direction, frame = "looking", 0.12, 1, 0
            food = (max(1, 3 - int((elapsed % 14.0 - 5.0) / 1.0))
                    if behavior == "snacking" else 3)
            return {
                "kind": self._kind, "name": _NAMES[self._kind],
                "activity": activity, "behavior": behavior,
                "status": activity_status(activity),
                "motion": self._motion, "frame": frame,
                "position": position, "direction": direction, "food": food,
            }

    def render(self, width, height=3):
        return render_pet(self.snapshot(), width=width, height=height)


def _sprite(kind, behavior, frame, direction):
    blink = frame == 7
    tail = "~" if frame % 2 == 0 else "/"
    cat = [" /\\_/\\  ", "( -.- )" if blink else "( o.o )", " /|_|\\" + tail]
    owl = [" /\\^/\\  ", "( - V -)" if blink else "( O V O)", " /)___(\\"]
    dog = [" /`---`\\ ", "( - _ - )" if blink else "( o _ o )", " /[w]_\\" + tail]
    rows = {"cat": cat, "owl": owl, "bulldog": dog}[kind]
    if behavior in ("typing", "working"):
        paws = ("o[====]O", "O[====]o", "o[====]o", "^[====]^")
        rows[2] = " " + paws[frame % len(paws)]
        if kind == "owl":
            rows[1] = "( o V o)" if not blink else "( - V -)"
    elif behavior == "speaking":
        mouth = (".", "o", "O", "o")[frame % 4]
        rows[1] = {"cat": "( o%so )", "owl": "( O %s O)",
                   "bulldog": "( o %s o )"}[kind] % mouth
        rows[2] = ({"cat": " o|_|/~", "owl": "<)___(\\",
                    "bulldog": " o[w]/~"} if frame % 4 < 2 else
                   {"cat": " /|_|o~", "owl": " /)___(>",
                    "bulldog": " /[w]o~"})[kind]
    elif behavior == "pondering":
        rows[0] = rows[0].rstrip() + (" ?" if frame % 4 < 2 else " .")
        rows[1] = {"cat": "( o.O )", "owl": "( O V o)",
                   "bulldog": "( O _ o )"}[kind]
        rows[2] = {"cat": " /|_o/~", "owl": " /)__o(\\",
                   "bulldog": " /[w]o~"}[kind]
    elif behavior == "reading":
        rows[2] = " o[<|>]o" if frame % 4 < 2 else " o[>|<]o"
    elif behavior == "searching":
        rows[1] = {"cat": "( o.O )", "owl": "( O V O)",
                   "bulldog": "( o _ O )"}[kind]
        rows[2] = " /|_|(O)" if frame % 4 < 2 else " (O)|_|\\"
    elif behavior in ("walking_to_bowl", "walking_back", "strolling"):
        if kind == "cat":
            rows[1] = "( o.o)>" if direction > 0 else "<(o.o )"
            rows[2] = " /|_ \\" + tail if frame % 2 else " \\ _|/" + tail
        elif kind == "owl":
            rows[1] = "( O V O)>" if direction > 0 else "<(O V O)"
            rows[2] = " /)__v(\\" if frame % 2 else " /)v__(\\"
        else:
            rows[1] = "( o _ o)>" if direction > 0 else "<(o _ o )"
            rows[2] = " /[w] \\" + tail if frame % 2 else " \\ [w]/" + tail
    elif behavior == "snacking":
        mouths = {
            "cat": ("( -.-)>", "( -w-)>", "( -.-)>", "( -o-)>"),
            "owl": ("( - V -)>", "( - v -)>", "( - V -)>", "( - o -)>"),
            "bulldog": ("( - _ -)>", "( - w -)>", "( - _ -)>", "( - U -)>"),
        }
        rows[1] = mouths[kind][frame % 4]
        rows[2] = {"cat": " /|_|\\>", "owl": " /)___(>",
                   "bulldog": " /[w]_\\>"}[kind]
        # Lean the muzzle down beside the bowl, within the same sprite bounds.
        rows = [row.rstrip().rjust(_SPRITE_WIDTH) for row in rows]
    elif behavior == "grooming":
        rows[1] = {"cat": "( -.-)o", "owl": "( - V -)/",
                   "bulldog": "( o _ o )"}[kind]
        if frame % 2:
            rows[2] = {"cat": " /|_o\\~", "owl": " <)___(\\",
                       "bulldog": " /[w]U\\~"}[kind]
    elif behavior == "stretching":
        rows[1] = {"cat": "( ^.^ )", "owl": "( ^ V ^)",
                   "bulldog": "( ^ _ ^ )"}[kind]
        rows[2] = {"cat": " /__|__\\~", "owl": "<)__|__(>",
                   "bulldog": " /__[w]_\\"}[kind]
    elif behavior in ("sleeping", "resting", "settling"):
        rows[1] = {"cat": "( -.- )", "owl": "( - V -)",
                   "bulldog": "( - _ - )"}[kind]
        if behavior == "sleeping":
            rows[0] = rows[0].rstrip() + (" z" if frame % 2 else " Z")
        if behavior == "settling":
            rows[2] = {"cat": " /|_|\\ ", "owl": " /)___(\\",
                       "bulldog": " /[w]_\\ "}[kind]
    elif behavior == "celebrating":
        rows[1] = {"cat": "( ^.^ )", "owl": "( ^ V ^)",
                   "bulldog": "( ^ _ ^ )"}[kind]
        poses = {
            "cat": (" \\|_|/~", "  v v  ~", " /|_|\\~", " \\o_o/~"),
            "owl": ("<)___(>", " \\)_(//", " /)___(\\", "<)__v_(>"),
            "bulldog": (" \\[w]/~", "  v v  ~", " /[w]_\\~", " \\[w]/~"),
        }
        rows[2] = poses[kind][frame % 4]
    elif behavior in ("watching", "curious", "looking") and frame % 4 == 2:
        rows[1] = {"cat": "( o.O )", "owl": "( O V o)",
                   "bulldog": "( O _ o )"}[kind]
    return [row[:_SPRITE_WIDTH].ljust(_SPRITE_WIDTH) for row in rows]


def _number(value, default):
    try:
        result = float(value)
        return result if math.isfinite(result) else default
    except (TypeError, ValueError, OverflowError):
        return default


_DEFAULT_PET = TerminalPet()


def render_pet(pet=None, width=20, height=3):
    """Return exactly ``height`` ASCII rows, each exactly ``width`` columns."""
    width = max(0, int(width))
    height = max(0, int(height))
    if height == 0:
        return []
    if width == 0:
        return [""] * height
    state = (_DEFAULT_PET if pet is None else pet)
    state = state.snapshot() if isinstance(state, TerminalPet) else state
    state = state if isinstance(state, dict) else {}
    kind = normalize_pet(state.get("kind")) or "cat"
    motion = bool(state.get("motion", True))
    behavior = str(state.get("behavior", "looking")) if motion else "looking"
    frame = int(_number(state.get("frame"), 0)) % 8 if motion else 0
    direction = -1 if _number(state.get("direction"), 1) < 0 else 1
    position = _number(state.get("position"), 0.12) if motion else 0.12
    position = max(0.0, min(1.0, position))
    if width <= 12:
        face = {"cat": "(o.o)", "owl": "(OvO)", "bulldog": "(o_w_o)"}[kind]
        if (motion and frame == 7) or behavior in ("sleeping", "resting", "settling"):
            face = face.replace("o", "-").replace("O", "-")
        if behavior == "celebrating":
            face = face.replace("o", "^").replace("O", "^")
        elif behavior == "speaking":
            mouth = (".", "o", "O", "o")[frame % 4]
            face = {"cat": "(o%so)", "owl": "(O%sO)",
                    "bulldog": "(o_%s_o)"}[kind] % mouth
        compact = [(" ^_^ " if kind == "cat" else " /\\^/\\ " if kind == "owl"
                    else " /`_`\\ "), face,
                   ("o[==] " if frame % 2 else " [==]o")
                   if behavior in ("typing", "working") else "  oo  "]
        if height == 1:
            compact = [face]
        return [row[:width].center(width) for row in
                (compact[:height] + [""] * max(0, height - len(compact)))]
    bowl_x = width - 5 if width >= 18 else None
    right_limit = bowl_x - 1 if bowl_x is not None else width
    x = int(round(position * max(0, right_limit - _SPRITE_WIDTH)))
    canvas = [[" "] * width for _ in range(3)]
    for y, row in enumerate(_sprite(kind, behavior, frame, direction)):
        canvas[y][x:x + len(row)] = row
    if bowl_x is not None:
        food = int(max(1, min(3, _number(state.get("food"), 3))))
        bowl = {3: "[:::]", 2: "[ : ]", 1: "[ . ]"}[food] if behavior == "snacking" else "[:::]"
        canvas[2][bowl_x:bowl_x + 5] = bowl
    if behavior == "celebrating":
        # Sparkles stay inside the habitat and never cover the pet or its bowl.
        for y, offset, char in ((0, -2, "*"), (1, _SPRITE_WIDTH + 1, "+"),
                                (0, _SPRITE_WIDTH + 2, ".")):
            spark_x = x + offset + frame % 2
            if 0 <= spark_x < right_limit and canvas[y][spark_x] == " ":
                canvas[y][spark_x] = char
    rows = ["".join(row) for row in canvas]
    if height == 1:
        rows = [rows[1]]
    elif height == 2:
        rows = rows[1:]
    return rows[:height] + [" " * width] * max(0, height - len(rows))
