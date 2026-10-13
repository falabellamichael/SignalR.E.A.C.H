"""Recognize a normal final answer without another bookkeeping request."""


def incomplete_finish(result):
    """Only known successful protocol endings may supply actions or success."""
    return result.get("finish_reason") not in (None, "stop", "tool_calls", "function_call")


def answer_text(text):
    """Return prose/code outside valid control fences, or None if malformed.

    Reuse the chat parser's fence rules so nested and indented examples stay
    ordinary answer content. An unfinished control is never a final answer.
    """
    import json
    from .chat import (_closes_fence, _explicit_control, _fence_line,
                       _normalise_action, _normalise_status)

    visible, held = [], []
    opener = control = None
    for line in (text or "").splitlines(keepends=True):
        if opener is None:
            fence = _fence_line(line)
            if not fence:
                visible.append(line)
                continue
            opener = fence[0]
            control = fence[1] if fence == ("```", "tool") or fence == ("```", "agent_status") else None
            held = [line] if control else []
            if not control:
                visible.append(line)
            continue
        if control:
            held.append(line)
            payload = _explicit_control("".join(held), control)
            if payload is not None:
                if control == "agent_status":
                    valid = _normalise_status(payload[0]) is not None
                else:
                    valid = _normalise_action(json.loads(payload[0])) is not None
                if not valid:
                    return None
                visible.append(payload[1])
                opener = control = None
            elif _closes_fence(line, opener):
                return None
        else:
            visible.append(line)
            if _closes_fence(line, opener):
                opener = None
    return None if control else "".join(visible).strip()


def clean_final_answer(result, invalid=False):
    """A provider's normal stop is final only when it contains a real answer."""
    return (not invalid and result.get("finish_reason") == "stop"
            and bool(answer_text(result.get("content") or "")))
