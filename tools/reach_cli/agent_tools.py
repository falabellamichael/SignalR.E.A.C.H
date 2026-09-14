"""The REACH CLI agent tool registry.

Mirrors the VS Code extension's tools.js: one source of truth for every agent
tool — its name, whether it needs user approval, its output budget, and the
help line the model sees. The agent system prompt and the executor both read
from here so the two lists cannot drift apart.

Every tool runs locally inside the workpath. Read-class tools never prompt;
exec/write-class tools prompt once per action unless the user chose "always".
"""

import fnmatch
import glob as _glob
import json
import os
import re
import subprocess

from .websearch import fetch_text, search_web

# Output budget: tool results get truncated to this many characters.
DEFAULT_BUDGET = 40000
MATCH_LIMIT = 200
LIST_ENTRY_LIMIT = 2000

IGNORED_DIRS = {
    ".git", "node_modules", "__pycache__", ".pytest_cache", ".venv",
    "venv", "dist", "build", ".files-work", "browser-profile",
}

BINARY_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip",
    ".gz", ".exe", ".dll", ".pyc", ".class", ".woff", ".woff2", ".ttf",
    ".otf", ".mp3", ".mp4", ".mov", ".sqlite", ".db",
}


def _truncate(text, budget=DEFAULT_BUDGET):
    if len(text) > budget:
        return text[:budget] + "\n... [truncated at %d chars]" % budget
    return text


def _safe_rel(path):
    rel = (path or "").replace("\\", "/")
    if not rel or rel.startswith("/") or re.match(r"^[a-zA-Z]:", rel):
        return None
    if any(part == ".." for part in rel.split("/")):
        return None
    return rel


def _resolve(workpath, rel):
    return os.path.join(workpath, *rel.split("/"))


# ---- individual tools ------------------------------------------------------

def tool_read(workpath, args, ctx):
    rel = _safe_rel(args.get("path"))
    if rel is None:
        return "error: invalid path %r" % args.get("path")
    target = _resolve(workpath, rel)
    if not os.path.isfile(target):
        return "error: no such file: %s" % rel
    try:
        with open(target, "r", encoding="utf-8", errors="replace") as handle:
            lines = handle.readlines()
    except OSError as exc:
        return "error: %s" % exc
    start = max(1, int(args.get("startLine") or 1))
    end = int(args.get("endLine") or len(lines))
    chosen = lines[start - 1:end]
    numbered = "".join(
        "%5d | %s" % (start + i, line) for i, line in enumerate(chosen)
    )
    return _truncate("%s (%d lines)\n%s" % (rel, len(lines), numbered))


def tool_glob(workpath, args, ctx):
    pattern = args.get("pattern") or "**/*"
    scope = _safe_rel(args.get("path") or "")
    base = _resolve(workpath, scope) if scope else workpath
    matches = _glob.glob(os.path.join(base, pattern), recursive=True)
    rels = []
    for match in sorted(matches)[:LIST_ENTRY_LIMIT]:
        if not os.path.isfile(match):
            continue
        rels.append(os.path.relpath(match, workpath).replace("\\", "/"))
    return _truncate("\n".join(rels) if rels else "no matches")


def _iter_files(base):
    if os.path.isfile(base):
        yield base
        return
    for root, dirs, files in os.walk(base):
        dirs[:] = [d for d in dirs if d not in IGNORED_DIRS and not d.startswith(".")]
        for name in files:
            yield os.path.join(root, name)


def tool_search(workpath, args, ctx):
    pattern = args.get("pattern")
    if not pattern:
        return "error: search needs a pattern"
    use_regex = bool(args.get("regex"))
    case_sensitive = bool(args.get("caseSensitive"))
    include = args.get("include") or ""
    flags = 0 if case_sensitive else re.IGNORECASE
    if use_regex:
        try:
            rx = re.compile(pattern, flags)
        except re.error as exc:
            return "error: bad regex: %s" % exc
    else:
        rx = re.compile(re.escape(pattern), flags)
    scope = _safe_rel(args.get("path") or "")
    base = _resolve(workpath, scope) if scope else workpath
    out = []
    for filepath in _iter_files(base):
        ext = os.path.splitext(filepath)[1].lower()
        if ext in BINARY_EXTENSIONS or os.path.getsize(filepath) > 2_000_000:
            continue
        rel = os.path.relpath(filepath, workpath).replace("\\", "/")
        if include and not fnmatch.fnmatch(rel, include):
            continue
        try:
            with open(filepath, "r", encoding="utf-8", errors="replace") as handle:
                for lineno, line in enumerate(handle, start=1):
                    if rx.search(line):
                        out.append("%s:%d: %s" % (rel, lineno, line.rstrip()[:200]))
                        if len(out) >= MATCH_LIMIT:
                            return _truncate("\n".join(out) + "\n... [match limit reached]")
        except OSError:
            continue
    return _truncate("\n".join(out) if out else "no matches")


def tool_list(workpath, args, ctx):
    rel = _safe_rel(args.get("path") or "")
    base = _resolve(workpath, rel) if rel else workpath
    if not os.path.isdir(base):
        return "error: no such directory: %s" % (rel or ".")
    lines = []

    def walk(directory, prefix, depth):
        if depth > 4 or len(lines) >= LIST_ENTRY_LIMIT:
            return
        try:
            entries = sorted(os.listdir(directory))
        except OSError:
            return
        for entry in entries:
            if entry in IGNORED_DIRS:
                continue
            full = os.path.join(directory, entry)
            if os.path.isdir(full):
                lines.append(prefix + entry + "/")
                walk(full, prefix + "  ", depth + 1)
            else:
                lines.append(prefix + entry)
            if len(lines) >= LIST_ENTRY_LIMIT:
                lines.append("... [entry limit reached]")
                return

    walk(base, "", 0)
    return _truncate("\n".join(lines) if lines else "(empty)")


def tool_shell(workpath, args, ctx):
    command = (args.get("command") or "").strip()
    if not command:
        return "error: shell needs a command"
    if not ctx["approve"]("shell", command):
        return "shell command denied by the user: %s" % command
    try:
        done = subprocess.run(
            command, shell=True, cwd=workpath, capture_output=True,
            text=True, timeout=180,
        )
    except subprocess.TimeoutExpired:
        return "error: command timed out after 180s: %s" % command
    except OSError as exc:
        return "error: %s" % exc
    out = (done.stdout or "") + (("\n[stderr]\n" + done.stderr) if done.stderr else "")
    return _truncate(
        "exit code %s\n%s" % (done.returncode, out.strip() or "(no output)")
    )


def tool_edit(workpath, args, ctx):
    rel = _safe_rel(args.get("path"))
    if rel is None:
        return "error: invalid path %r" % args.get("path")
    search = str(args.get("search", ""))
    replace = str(args.get("replace", ""))
    preview = replace[:80] if not search else "%s → %s" % (search[:80], replace[:80])
    if not ctx["approve"]("edit", "%s: %s" % (rel, preview)):
        return "edit denied by the user: %s" % rel
    target = _resolve(workpath, rel)
    try:
        if not os.path.exists(target):
            if search:
                return "error: %s does not exist (use empty search to create it)" % rel
            os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
            with open(target, "w", encoding="utf-8") as handle:
                handle.write(replace)
            return "created %s" % rel
        if not search:
            return "error: %s already exists (empty search only creates files)" % rel
        with open(target, "r", encoding="utf-8") as handle:
            current = handle.read()
        idx = current.find(search)
        if idx == -1:
            return "error: search text not found in %s — read the file again" % rel
        with open(target, "w", encoding="utf-8") as handle:
            handle.write(current[:idx] + replace + current[idx + len(search):])
        return "applied edit to %s" % rel
    except OSError as exc:
        return "error: %s" % exc


def tool_websearch(workpath, args, ctx):
    query = (args.get("query") or "").strip()
    if not query:
        return "error: websearch needs a query"
    found = search_web(query)
    results = found.get("results") or []
    if not results:
        return "no results (search engine unavailable or blocked)"
    lines = []
    for i, result in enumerate(results[:8], start=1):
        lines.append(
            "[%d] %s\n    %s" % (i, result.get("title", "")[:80], result.get("url", ""))
        )
    return _truncate("\n".join(lines))


def tool_browse(workpath, args, ctx):
    url = (args.get("url") or "").strip()
    if not url:
        return "error: browse needs a url"
    text = fetch_text(url)
    if not text:
        return "error: could not read %s" % url
    return _truncate("%s\n%s" % (url, text))


def tool_todo_write(workpath, args, ctx):
    todos = args.get("todos")
    if not isinstance(todos, list):
        return "error: todo_write needs a todos list"
    ctx["todos"][:] = [
        {
            "text": str(t.get("text", ""))[:200],
            "status": str(t.get("status", "pending")),
        }
        for t in todos
        if isinstance(t, dict) and str(t.get("text", "")).strip()
    ]
    return _format_todos(ctx["todos"])


def tool_todo_read(workpath, args, ctx):
    return _format_todos(ctx["todos"]) or "(no plan yet)"


def _format_todos(todos):
    if not todos:
        return "(empty plan)"
    return "\n".join(
        "%s %s"
        % ({"completed": "[x]", "in_progress": "[~]"}.get(t["status"], "[ ]"), t["text"])
        for t in todos
    )


# ---- registry --------------------------------------------------------------

TOOLS = {
    "read": {
        "approval": False,
        "help": "reads one file with numbered lines. Optional 1-based startLine/endLine for a range.",
        "example": {"action": "read", "path": "relative/path"},
        "run": tool_read,
    },
    "glob": {
        "approval": False,
        "help": "finds files by path/name pattern, e.g. \"**/*.py\". Optional path scopes the search.",
        "example": {"action": "glob", "pattern": "**/*.test.py"},
        "run": tool_glob,
    },
    "search": {
        "approval": False,
        "help": "greps file contents, returns \"path:line: text\" matches. Options: regex: true, include: \"src/**/*.js\", caseSensitive: true.",
        "example": {"action": "search", "pattern": "def \\w+", "regex": True, "include": "**/*.py"},
        "run": tool_search,
    },
    "list": {
        "approval": False,
        "help": "prints a directory tree (empty path = workpath root).",
        "example": {"action": "list", "path": ""},
        "run": tool_list,
    },
    "shell": {
        "approval": True,
        "help": "runs a command in the workpath and returns its output and exit code (the user must approve it first). Use it to verify your changes.",
        "example": {"action": "shell", "command": "python -m pytest tests/ -x"},
        "run": tool_shell,
    },
    "edit": {
        "approval": True,
        "help": "applies one edit to a file in the workpath, after user approval. Empty search creates a new file with the full content in replace.",
        "example": {"action": "edit", "path": "relative/path", "search": "exact existing text", "replace": "new text"},
        "run": tool_edit,
    },
    "websearch": {
        "approval": False,
        "help": "searches the web and lists the top results with URLs.",
        "example": {"action": "websearch", "query": "latest news"},
        "run": tool_websearch,
    },
    "browse": {
        "approval": False,
        "help": "opens a web page and returns its text.",
        "example": {"action": "browse", "url": "https://example.com"},
        "run": tool_browse,
    },
    "todo_write": {
        "approval": False,
        "help": "creates or updates the structured plan/checklist for multi-step tasks.",
        "example": {"action": "todo_write", "todos": [{"text": "Step 1", "status": "in_progress"}]},
        "run": tool_todo_write,
    },
    "todo_read": {
        "approval": False,
        "help": "reads the current structured plan/checklist.",
        "example": {"action": "todo_read"},
        "run": tool_todo_read,
    },
}


def tool_help_text():
    lines = []
    for name, tool in TOOLS.items():
        lines.append("- %s: %s" % (name, tool["help"]))
        lines.append("  %s" % json.dumps(tool["example"]))
    return "\n".join(lines)


def run_tool(name, args, workpath, ctx):
    """Execute one tool action. Returns the plain-text result."""
    tool = TOOLS.get(name)
    if not tool:
        return "error: unknown tool %r (available: %s)" % (name, ", ".join(TOOLS))
    try:
        return tool["run"](workpath, args or {}, ctx)
    except Exception as exc:  # a tool must never kill the agent loop
        return "error: %s" % exc
