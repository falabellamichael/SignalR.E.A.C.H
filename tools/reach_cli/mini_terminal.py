"""Explicit-submit state for the CLI's inline mini-terminal.

This module never executes commands itself. The caller must first receive a
submission request and then provide the existing approval and execution
callbacks. Model output is never parsed or submitted here.
"""
import unicodedata
import threading

from .hud import strip_terminal_controls


def safe_output(text, limit=1800):
    """Keep command output from moving or recolouring the user's terminal."""
    limit = max(1, int(limit))
    clean = strip_terminal_controls("" if text is None else str(text))[-limit:]
    try:
        from .agent_tools_extra import safe_text
        secured = safe_text(clean, limit=limit)
    except Exception:
        return clean
    without_format = "".join(
        char for char in clean if unicodedata.category(char) != "Cf")
    if secured == without_format:
        return clean
    return strip_terminal_controls(secured)[-limit:]


def _safe_command_preview(text, limit=600):
    """Redact command secrets without stripping ordinary Unicode joiners."""
    clean = strip_terminal_controls("" if text is None else str(text))
    truncated = len(clean) > limit
    candidate = clean[:max(0, limit - (1 if truncated else 0))]
    if truncated:
        candidate += "…"
    try:
        from .agent_tools_extra import safe_text
        secured = safe_text(candidate, limit=limit)
    except Exception:
        return candidate
    without_format = "".join(
        char for char in candidate if unicodedata.category(char) != "Cf")
    if secured == without_format:
        return candidate
    return strip_terminal_controls(secured)[:limit]


class MiniTerminal:
    def __init__(self):
        self._lock = threading.RLock()
        self._generation = 0
        self._pending = None
        self._next_id = 0
        self.focused = False
        self.draft = ""
        self.display_draft = ""
        self.status = "idle"
        self.output = ""

    def snapshot(self):
        with self._lock:
            return {
                "focused": self.focused,
                "draft": self.draft,
                "display_draft": self.display_draft,
                "status": self.status,
                "output": self.output,
                "pending": self._pending is not None,
            }

    def focus(self):
        with self._lock:
            self.focused = True
            self.status = "ready"
            return self.snapshot()

    def set_draft(self, text):
        with self._lock:
            if not self.focused:
                return False
            self.draft = str(text)
            preview = _safe_command_preview(self.draft, 600)
            self.display_draft = safe_output(preview, limit=600)
            self.status = "editing" if self.draft else "ready"
            return True

    def set_status(self, status):
        """Update a pending command's approval/execution status."""
        with self._lock:
            if self._pending is None:
                return False
            self.status = str(status or "running")[:32]
            return True

    def request_submit(self):
        """Capture an Enter-submitted command without running or approving it."""
        with self._lock:
            if not self.focused or self._pending is not None:
                return None
            command = self.draft.strip()
            if not command:
                return None
            self._next_id += 1
            request_id = self._next_id
            self._pending = (request_id, command, self._generation)
            self.status = "awaiting approval"
            return {"id": request_id, "command": command}

    def confirm_and_run(self, request_id, approve, execute):
        """Run only the current submitted command after the approval callback."""
        with self._lock:
            pending = self._pending
            if (pending is None or pending[0] != request_id or
                    pending[2] != self._generation or
                    not callable(approve) or not callable(execute)):
                return False
            _identifier, command, generation = pending
            self.status = "approving"

        try:
            allowed = bool(approve("shell", command))
        except KeyboardInterrupt:
            self.cancel()
            return False
        except Exception as exc:
            self._finish(request_id, generation, "approval error", safe_output(exc))
            return False

        with self._lock:
            if not self._is_current(request_id, generation):
                return False
            if not allowed:
                self._pending = None
                self.focused = False
                self.draft = ""
                self.status = "denied"
                self.output = "Command denied."
                return False
        return self.execute_submitted(request_id, execute)

    def execute_submitted(self, request_id, execute):
        """Run a submitted command through a caller-owned approved runner."""
        with self._lock:
            pending = self._pending
            if (pending is None or pending[0] != request_id or
                    pending[2] != self._generation or not callable(execute)):
                return False
            _identifier, command, generation = pending
            self.status = "awaiting approval"
        try:
            result = execute(command)
        except KeyboardInterrupt:
            self.cancel()
            return False
        except Exception as exc:
            self._finish(request_id, generation, "error", safe_output(exc))
            return False
        with self._lock:
            denied = self.status == "denied"
        self._finish(request_id, generation,
                     "denied" if denied else "complete",
                     "Command denied." if denied else safe_output(result))
        return not denied

    def cancel(self):
        """Drop focus and invalidate a queued or in-flight result."""
        with self._lock:
            self._generation += 1
            self._pending = None
            self.focused = False
            self.draft = ""
            self.display_draft = ""
            self.status = "cancelled"
            self.output = ""

    def blur(self):
        with self._lock:
            self.focused = False
            if self.status in ("ready", "editing"):
                self.status = "idle"

    def _finish(self, request_id, generation, status, output):
        with self._lock:
            if not self._is_current(request_id, generation):
                return False
            self._pending = None
            self.focused = False
            self.draft = ""
            self.display_draft = ""
            self.status = status
            self.output = output
            return True

    def _is_current(self, request_id, generation):
        pending = self._pending
        return (pending is not None and pending[0] == request_id and
                generation == self._generation and pending[2] == generation)
