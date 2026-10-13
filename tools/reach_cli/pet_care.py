"""Session-only companion care; called under TerminalPet's lock, without I/O."""

ATTENTION_REMINDER_SECONDS = 5 * 60
NEGLECT_SECONDS = 10 * 60
FORGIVENESS_TREATS = 3
REACTION_SECONDS = {
    "feed": 6.4, "pet": 3.2, "treat": 3.2, "forgive": 4.0,
    "refuse_food": 2.4, "refuse_pet": 2.4,
}


def parse_care_command(text):
    """Recognize complete local care commands, never prompts containing them."""
    parts = str(text or "").strip().casefold().split()
    if len(parts) == 1:
        return {"/feed": "feed", "/pat": "pet", "/treat": "treat"}.get(parts[0])
    if len(parts) == 2 and parts[0] == "/pet" and parts[1] in ("feed", "pet", "treat"):
        return parts[1]
    return None


def care_status(state):
    """Fixed UI text only: arbitrary snapshot text never enters the header."""
    try:
        treats = max(1, min(FORGIVENESS_TREATS, int(state.get("treats_remaining", 3))))
    except (TypeError, ValueError, OverflowError):
        treats = FORGIVENESS_TREATS
    reaction = str(state.get("care_reaction") or "")
    if reaction == "feed":
        return "Dinner! Thank you."
    if reaction == "pet":
        return {"cat": "Prrrr... more please!", "owl": "Happy hoots!",
                "bulldog": "Happy snuffles!"}.get(str(state.get("kind")), "Happy pats!")
    if reaction == "forgive":
        return "I forgive you!"
    if state.get("mood") == "angry":
        prefix = {"refuse_food": "No food!", "refuse_pet": "No pats!",
                  "treat": "Still grumpy"}.get(reaction, "I'm angry")
        return "%s · /treat x%d" % (prefix, treats)
    if reaction == "treat":
        return "Yum! You're my favorite."
    if state.get("mood") == "lonely":
        return "I miss you · /feed /pat"
    return ""


class PetCare:
    """Each visited companion remembers attention and unfinished forgiveness.

    The owner supplies a monotonic clock, so no worker, disk writes, or offline
    catch-up are required. Only explicit care counts as attention; animated
    snacks, typing, responses, and switching companions do not count.
    """

    def __init__(self, kind, now):
        self._states = {}
        self.select(kind, now)

    def select(self, kind, now):
        self._kind = kind
        self._states.setdefault(kind, {
            "attention_at": now, "angry": False, "treats_remaining": 0,
            "reaction": "", "reaction_at": now,
        })

    def _current(self, now):
        state = self._states[self._kind]
        if not state["angry"] and now - state["attention_at"] >= NEGLECT_SECONDS:
            state["angry"] = True
            state["treats_remaining"] = FORGIVENESS_TREATS
        return state

    def dismiss_reactions(self):
        """A newly finished/stopped response must show its own animation."""
        for state in self._states.values():
            state["reaction"] = ""

    def snapshot(self, now):
        state = self._current(now)
        age = max(0.0, now - state["attention_at"])
        mood = "angry" if state["angry"] else (
            "lonely" if age >= ATTENTION_REMINDER_SECONDS else "content")
        reaction = state["reaction"]
        elapsed = max(0.0, now - state["reaction_at"])
        if elapsed >= REACTION_SECONDS.get(reaction, 0):
            reaction = ""
        return {"mood": mood, "treats_remaining": state["treats_remaining"],
                "care_reaction": reaction, "care_elapsed": elapsed}

    def perform(self, action, now):
        if action not in ("feed", "pet", "treat"):
            raise ValueError("Unsupported pet care action: %s" % action)
        state = self._current(now)
        accepted = not state["angry"] or action == "treat"
        reaction = action
        if not accepted:
            reaction = "refuse_food" if action == "feed" else "refuse_pet"
        elif state["angry"]:
            state["treats_remaining"] -= 1
            if not state["treats_remaining"]:
                state["angry"] = False
                state["attention_at"] = now
                reaction = "forgive"
        else:
            state["attention_at"] = now
        state["reaction"], state["reaction_at"] = reaction, now
        view = self.snapshot(now)
        view["kind"] = self._kind
        return {"accepted": accepted, "message": care_status(view),
                "mood": view["mood"], "treats_remaining": view["treats_remaining"]}


def care_animation(reaction, elapsed):
    """Return a short visual overlay without changing the response lifecycle."""
    if reaction == "feed":
        if elapsed < 1.6:
            return "walking_to_bowl", elapsed / 1.6, 1, 3
        if elapsed < 4.8:
            return "snacking", 1.0, 1, max(1, 3 - int(elapsed - 1.6))
        return "walking_back", max(0.0, 1.0 - (elapsed - 4.8) / 1.6), -1, 3
    behavior = {"pet": "petting", "treat": "treating", "forgive": "forgiving",
                "refuse_food": "refusing", "refuse_pet": "refusing"}.get(reaction)
    return (behavior, 0.12, 1, 3) if behavior else None
