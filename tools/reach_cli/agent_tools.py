"""The REACH CLI agent tool registry.

Mirrors the VS Code extension's tools.js: one source of truth for every agent
tool — its name, whether it needs user approval, its output budget, and the
help line the model sees. The agent system prompt and the executor both read
from here so the two lists cannot drift apart.

Every tool runs locally inside the workpath. Read-class tools never prompt;
exec/write-class tools prompt once per action unless the user chose "always".
"""

import fnmatch
from functools import lru_cache
import json
import os
import re
import subprocess

from .websearch import fetch_text, search_web
from .agent_tools_extra import (
    EXTRA_TOOLS, FILE_LIMIT, cleanup_owned_processes, resolve_path, safe_text,
    _display_file,
)

# Output budget: tool results get truncated to this many characters.
DEFAULT_BUDGET = 40000
MATCH_LIMIT = 200
LIST_ENTRY_LIMIT = 2000
FILE_SCAN_LIMIT = 10000

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
    return safe_text(text, budget)


def _safe_rel(path):
    if not isinstance(path, str):
        return None
    rel = path.replace("\\", "/")
    if not rel or rel.startswith("/") or ":" in rel or any(ord(c) < 32 for c in rel):
        return None
    if any(part == ".." for part in rel.split("/")):
        return None
    return rel


def _resolve(workpath, rel):
    return resolve_path(workpath, rel, root=True)


# ---- individual tools ------------------------------------------------------

def tool_read(workpath, args, ctx):
    rel = _safe_rel(args.get("path"))
    if rel is None:
        return "error: invalid path %r" % args.get("path")
    target = _resolve(workpath, rel)
    if not os.path.isfile(target):
        return "error: no such file: %s" % rel
    try:
        if os.path.getsize(target) > FILE_LIMIT:
            return "error: file exceeds the 2 MiB text limit; use an approved command for a larger file"
        with open(target, "r", encoding="utf-8", errors="replace") as handle:
            lines = handle.readlines()
    except OSError as exc:
        return "error: %s" % exc
    start = max(1, int(args.get("startLine") or 1))
    end = int(args.get("endLine") or len(lines))
    chosen = _display_file(target, "".join(lines[start - 1:end])).splitlines(True)
    numbered = "".join(
        "%5d | %s" % (start + i, line) for i, line in enumerate(chosen)
    )
    return _truncate("%s (%d lines)\n%s" % (rel, len(lines), numbered))


def tool_glob(workpath, args, ctx):
    pattern = args.get("pattern") or "**/*"
    if not isinstance(pattern, str) or pattern.startswith(("/", "\\")) or ":" in pattern or ".." in pattern.replace("\\", "/").split("/"):
        return "error: glob pattern must stay within the workpath"
    scope = _safe_rel(args.get("path") or "")
    if args.get("path") and scope is None:
        return "error: invalid path"
    # Use one canonical root for walking and relative paths. On Windows the
    # resolved workpath spelling can differ from the caller's spelling.
    work_root = os.path.realpath(os.path.abspath(workpath))
    base = _resolve(work_root, scope) if scope else work_root
    pattern_parts = tuple(pattern.replace("\\", "/").split("/"))
    if len(pattern_parts) > 128 or len(pattern) > 4096:
        return "error: glob pattern exceeds the bounded search limit"
    rels = []
    scanned, limited = 0, False
    for root, dirs, files in os.walk(base, followlinks=False):
        # Never descend a junction/reparse/symlink, even before filtering its
        # results. stdlib recursive glob follows directory links by default.
        dirs[:] = [name for name in sorted(dirs) if not _directory_link(os.path.join(root, name))]
        for filename in sorted(files):
            scanned += 1
            if scanned > FILE_SCAN_LIMIT:
                limited = True
                break
            match = os.path.join(root, filename)
            rel = os.path.relpath(match, work_root).replace("\\", "/")
            try:
                _resolve(work_root, rel)
            except ValueError:
                continue
            scoped = tuple(os.path.relpath(match, base).replace("\\", "/").split("/"))
            if _glob_match(scoped, pattern_parts):
                rels.append(rel)
                if len(rels) >= LIST_ENTRY_LIMIT:
                    limited = True
                    break
        if limited:
            break
    output = "\n".join(sorted(rels)) if rels else "no matches"
    return _truncate(output + ("\n... [entry/search limit reached]" if limited else ""))


def _directory_link(path):
    try:
        info = os.lstat(path)
        return os.path.islink(path) or bool(getattr(info, "st_file_attributes", 0) & 0x400)
    except OSError:
        return True


def _glob_match(parts, pattern):
    @lru_cache(None)
    def matches(index, at):
        if at == len(pattern):
            return index == len(parts)
        if pattern[at] == "**":
            return matches(index, at + 1) or (index < len(parts) and
                not parts[index].startswith(".") and matches(index + 1, at))
        if index == len(parts) or (parts[index].startswith(".") and not pattern[at].startswith(".")):
            return False
        return fnmatch.fnmatchcase(parts[index], pattern[at]) and matches(index + 1, at + 1)
    return matches(0, 0)


def _iter_files(base):
    if os.path.isfile(base):
        yield base
        return
    for root, dirs, files in os.walk(base):
        dirs[:] = [d for d in dirs if d not in IGNORED_DIRS and not d.startswith(".")
                   and not _directory_link(os.path.join(root, d))]
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
    if args.get("path") and scope is None:
        return "error: invalid path"
    base = _resolve(workpath, scope) if scope else workpath
    out = []
    for scanned, filepath in enumerate(_iter_files(base), 1):
        if scanned > FILE_SCAN_LIMIT:
            return _truncate("\n".join(out) + "\n... [search limit reached]")
        ext = os.path.splitext(filepath)[1].lower()
        if ext in BINARY_EXTENSIONS or os.path.getsize(filepath) > 2_000_000:
            continue
        rel = os.path.relpath(filepath, workpath).replace("\\", "/")
        try:
            _resolve(workpath, rel)
        except ValueError:
            continue
        if include and not fnmatch.fnmatch(rel, include):
            continue
        try:
            with open(filepath, "r", encoding="utf-8", errors="replace") as handle:
                for lineno, line in enumerate(handle, start=1):
                    if rx.search(line):
                        out.append("%s:%d: %s" % (rel, lineno, _display_file(filepath, line.rstrip())[:200]))
                        if len(out) >= MATCH_LIMIT:
                            return _truncate("\n".join(out) + "\n... [match limit reached]")
        except OSError:
            continue
    return _truncate("\n".join(out) if out else "no matches")


def tool_list(workpath, args, ctx):
    rel = _safe_rel(args.get("path") or "")
    if args.get("path") and rel is None:
        return "error: invalid path"
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
            try:
                _resolve(workpath, os.path.relpath(full, workpath).replace("\\", "/"))
            except ValueError:
                continue
            if os.path.isdir(full):
                lines.append(prefix + entry + "/")
                if not _directory_link(full):
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
    if not ctx["approve"]("shell", safe_text(command, 500)):
        return "shell command denied by the user: %s" % safe_text(command)
    try:
        done = subprocess.run(
            command, shell=True, cwd=workpath, capture_output=True,
            text=True, timeout=180, stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired:
        return "error: command timed out after 180s: %s" % command
    except OSError as exc:
        return "error: %s" % exc
    out = (done.stdout or "") + (("\n[stderr]\n" + done.stderr) if done.stderr else "")
    return _truncate(
        "exit code %s\n%s" % (done.returncode, out.strip() or "(no output)")
    )


def _raw_edit_span(text, search):
    start = text.find(search)
    while start != -1:
        end = start + len(search)
        # A lone CR or LF within CRLF is not a complete line ending.
        if not ((start > 0 and text[start - 1:start + 1] == "\r\n")
                or (end < len(text) and text[end - 1:end + 1] == "\r\n")):
            return start, end
        start = text.find(search, start + 1)
    return None


def _newline_tolerant_edit_span(text, search):
    if "\r" not in search and "\n" not in search:
        return None
    pieces = re.split(r"\r\n|\r|\n", search)
    pattern = r"(?:\r\n|\r(?!\n)|(?<!\r)\n)".join(re.escape(piece) for piece in pieces)
    return re.search(pattern, text)


def _edit_replacement_newlines(replacement, endings):
    styles = list(dict.fromkeys(endings))
    counts = [endings.count(style) for style in styles]
    if counts.count(max(counts)) > 1 and len(re.findall(r"\r\n|\r|\n", replacement)) == len(endings):
        # A mixed-style tie can retain each matched newline by position.
        matched = iter(endings)
        return re.sub(r"\r\n|\r|\n", lambda _match: next(matched), replacement)
    style = styles[counts.index(max(counts))]
    return re.sub(r"\r\n|\r|\n", lambda _match: style, replacement)


def tool_edit(workpath, args, ctx):
    rel = _safe_rel(args.get("path"))
    if rel is None:
        return "error: invalid path %r" % args.get("path")
    search = str(args.get("search", ""))
    replace = str(args.get("replace", ""))
    target = resolve_path(workpath, rel, write=True)
    preview = "%d existing characters -> %d replacement characters" % (len(search), len(replace))
    if not ctx["approve"]("edit", "%s: %s" % (rel, preview)):
        return "edit denied by the user: %s" % rel
    target = resolve_path(workpath, rel, write=True)
    try:
        if not os.path.exists(target):
            if search:
                return "error: %s does not exist (use empty search to create it)" % rel
            os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
            with open(target, "w", encoding="utf-8", newline="") as handle:
                handle.write(replace)
            return "created %s" % rel
        if not search:
            return "error: %s already exists (empty search only creates files)" % rel
        with open(target, "r", encoding="utf-8", newline="") as handle:
            current = handle.read()
        span = _raw_edit_span(current, search)
        if span is None:
            match = _newline_tolerant_edit_span(current, search)
            if match is None:
                return "error: search text not found in %s — read the file again" % rel
            span = match.span()
        # Follow the matched line endings, or the nearest preceding/following
        # line ending for a single-line match. Unmatched bytes stay verbatim.
        endings = re.findall(r"\r\n|\r|\n", current[span[0]:span[1]])
        if not endings:
            preceding = re.findall(r"\r\n|\r|\n", current[:span[0]])
            following = re.search(r"\r\n|\r|\n", current[span[1]:])
            endings = preceding[-1:] or ([following.group()] if following else [])
        replacement = _edit_replacement_newlines(replace, endings) if endings else replace
        with open(target, "w", encoding="utf-8", newline="") as handle:
            handle.write(current[:span[0]] + replacement + current[span[1]:])
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


# Models routinely re-key the plan fields — Claude-flavoured "content",
# task trackers' "task"/"description", "items"/"tasks" for the list itself.
# Accept the common spellings instead of silently dropping every item.
_TODO_LIST_KEYS = ("todos", "items", "tasks", "plan", "steps", "list")
_TODO_TEXT_KEYS = ("text", "content", "task", "description", "title", "item")
_TODO_STATUS = {
    "completed": "completed", "complete": "completed", "done": "completed",
    "finished": "completed", "closed": "completed", "resolved": "completed",
    "checked": "completed",
    "in_progress": "in_progress", "inprogress": "in_progress",
    "active": "in_progress", "started": "in_progress", "working": "in_progress",
    "doing": "in_progress", "current": "in_progress", "ongoing": "in_progress",
    "wip": "in_progress",
}
# Anything not recognised lands on "pending" — safer than storing a verbatim
# status the completion gate ("!= completed") would treat as open forever.


def _todo_status(item):
    for flag in (item.get("done"), item.get("completed")):
        if flag is True or str(flag).strip().lower() in ("true", "yes", "1"):
            return "completed"
    for key in ("status", "state", "completed"):
        raw = str(item.get(key, "")).strip().lower()
        raw = raw.replace("-", "_").replace(" ", "_")
        if raw in _TODO_STATUS:
            return _TODO_STATUS[raw]
    return "pending"


def tool_todo_write(workpath, args, ctx):
    todos = args.get("todos")
    if not isinstance(todos, list):
        for key in _TODO_LIST_KEYS:
            if isinstance(args.get(key), list):
                todos = args[key]
                break
    if not isinstance(todos, list):
        todos = next((v for v in args.values() if isinstance(v, list)), None)
    if not isinstance(todos, list):
        return "error: todo_write needs a todos list"
    out = []
    dropped = 0
    for item in todos:
        if isinstance(item, str):
            item = {"text": item}
        if not isinstance(item, dict):
            dropped += 1
            continue
        text = next(
            (str(item.get(k)) for k in _TODO_TEXT_KEYS
             if str(item.get(k, "")).strip()),
            "",
        )
        if not text.strip():
            dropped += 1
            continue
        out.append({"text": text.strip()[:200], "status": _todo_status(item)})
    ctx["todos"][:] = out
    result = _format_todos(ctx["todos"])
    if dropped:
        result += "\n(dropped %d item(s) with no text)" % dropped
    return result


def tool_todo_read(workpath, args, ctx):
    return _format_todos(ctx["todos"]) or "(no plan yet)"


def _format_todos(todos):
    if not todos:
        return "(empty plan)"
    # Same checklist the VS Code panel renders: ○ ◐ ✓ + an "N/M done" head.
    done = sum(1 for t in todos if t["status"] == "completed")
    marks = {"completed": "✓", "in_progress": "◐"}
    lines = ["Agent plan — %d/%d done" % (done, len(todos))]
    lines += [
        "%s %s" % (marks.get(t["status"], "○"), t["text"])
        for t in todos
    ]
    return "\n".join(lines)


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
        "help": "creates or updates the structured plan/checklist for multi-step tasks. Each item needs a text field; status is pending, in_progress or completed.",
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


DEFAULT_TOOL_NAMES = tuple(TOOLS) + ("tool_discover",)
MAX_SELECTED_TOOLS = 5
for _name, _tool in TOOLS.items():
    _tool["category"] = ("files" if _name in ("read", "glob", "search", "list", "edit") else
                         "execution" if _name == "shell" else
                         "web" if _name in ("websearch", "browse") else "planning")
TOOLS.update(EXTRA_TOOLS)


def tool_help_text(names=None):
    """Compact fallback prompt help; discovery exposes the remaining catalog."""
    lines = []
    for name in DEFAULT_TOOL_NAMES if names is None else names:
        tool = TOOLS.get(name)
        if tool is None:
            continue
        lines.append("- %s: %s" % (name, tool["help"]))
        lines.append("  %s" % json.dumps(tool["example"]))
    if names is None:
        lines.append("More tools: files, git, execution, processes, web, planning. "
                     "Call tool_discover with a category/query or exact names to inspect and enable relevant schemas.")
    return "\n".join(lines)


# JSON-schema parameters for each tool, for OpenAI-style native tool calling.
_S = {"type": "string"}
TOOL_PARAMETERS = {
    "read": ({"path": _S, "startLine": {"type": "integer"},
              "endLine": {"type": "integer"}}, ["path"]),
    "glob": ({"pattern": _S, "path": _S}, ["pattern"]),
    "search": ({"pattern": _S, "regex": {"type": "boolean"}, "include": _S,
                "caseSensitive": {"type": "boolean"}, "path": _S}, ["pattern"]),
    "list": ({"path": _S}, []),
    "shell": ({"command": _S}, ["command"]),
    "edit": ({"path": _S, "search": _S, "replace": _S}, ["path", "replace"]),
    "websearch": ({"query": _S}, ["query"]),
    "browse": ({"url": _S}, ["url"]),
    "todo_write": ({"todos": {"type": "array", "items": {
        "type": "object",
        "properties": {"text": _S, "status": {
            "type": "string", "enum": ["pending", "in_progress", "completed"]}},
        "required": ["text"]}}}, ["todos"]),
    "todo_read": ({}, []),
}
for _name, _tool in EXTRA_TOOLS.items():
    TOOL_PARAMETERS[_name] = _tool["parameters"]


def tool_catalog(query="", category="", names=None):
    """Search the full executable catalog without executing any tool."""
    if not isinstance(query, str) or not isinstance(category, str):
        raise ValueError("query and category must be strings")
    if names is not None and (not isinstance(names, (list, tuple, set)) or
                              not all(isinstance(name, str) for name in names)):
        raise ValueError("names must be an array of tool names")
    wanted = set(names) if names is not None else None
    words = query.lower().split()
    found = []
    for name, tool in TOOLS.items():
        if wanted is not None and name not in wanted:
            continue
        if category and tool["category"].lower() != category.lower():
            continue
        searchable = "%s %s %s" % (name, tool["category"], tool["help"])
        if not all(word in searchable.lower() for word in words):
            continue
        props, required = TOOL_PARAMETERS.get(name, ({}, []))
        params = {"type": "object", "properties": props, "required": required}
        found.append({"name": name, "category": tool["category"], "approval": tool["approval"],
                      "description": tool["help"], "parameters": params})
    # Return independent objects; callers cannot mutate executable schema metadata.
    return json.loads(json.dumps(found))


def help_lines(query=""):
    return ["%s  [%s; %s] %s" % (item["name"], item["category"],
             "approval" if item["approval"] else "read/state", item["description"])
            for item in tool_catalog(query=query)]


def tool_discover(workpath, args, ctx):
    query, category, names = args.get("query", ""), args.get("category", ""), args.get("names")
    records = tool_catalog(query, category, names)
    if names is not None:
        unknown = sorted(set(names) - set(TOOLS))
        if unknown:
            return "error: unknown tool names: %s; call tool_discover without names to see the catalog" % ", ".join(unknown)
    activated = []
    if args.get("activate", True) and (query or category or names):
        selected = ctx.setdefault("selected_tools", set())
        if not isinstance(selected, set):
            raise ValueError("selected_tools context must be a persistent set")
        activated = [item["name"] for item in records if item["name"] not in DEFAULT_TOOL_NAMES][:MAX_SELECTED_TOOLS]
        selected.clear()
        selected.update(activated)
    return json.dumps({"total_available": len(TOOLS), "matched": len(records), "activated": activated,
                       "selection_limit": MAX_SELECTED_TOOLS,
                       "note": "Discovery never runs tools; activated schemas are available on the next request. "
                               "Select specific names when more than five tools match.",
                       "tools": records}, ensure_ascii=False)


TOOLS["tool_discover"] = {
    "approval": False, "category": "discovery", "help": "Search the full tool catalog by query/category/exact names; enable up to five additional tool schemas for the next request. Discovery executes no actions.",
    "example": {"action": "tool_discover", "category": "git"}, "run": tool_discover,
}
TOOL_PARAMETERS["tool_discover"] = ({"query": _S, "category": _S,
    "names": {"type": "array", "items": _S, "maxItems": 36}, "activate": {"type": "boolean"}}, [])


def tool_schemas(names=None):
    """The registry in OpenAI ``tools`` format (function schemas)."""
    schemas = []
    seen = set()
    for name in DEFAULT_TOOL_NAMES if names is None else names:
        if name in seen or name not in TOOLS:
            continue
        seen.add(name)
        tool = TOOLS[name]
        props, required = TOOL_PARAMETERS.get(name, ({}, []))
        params = {"type": "object", "properties": dict(props)}
        if required:
            params["required"] = list(required)
        schemas.append({
            "type": "function",
            "function": {"name": name, "description": tool["help"],
                         "parameters": params},
        })
    return schemas


tool_specs = tool_schemas


def parse_tool_arguments(raw):
    """Decode native tool-call arguments. Returns (args, error)."""
    if isinstance(raw, dict):
        return raw, None
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return {}, None
    try:
        data = json.loads(raw)
    except (TypeError, ValueError) as exc:
        return None, "arguments were not valid JSON (%s); resend the call" % exc
    if not isinstance(data, dict):
        return None, "arguments must be a JSON object; resend the call"
    return data, None


# ---- display helpers (compact, human-readable tool lines) -----------------

def format_args(name, args, limit=72):
    """Compact ``key=value`` args for a tool line instead of raw JSON."""
    args = args or {}
    if name == "todo_write" and isinstance(args.get("todos"), list):
        return "%d item(s)" % len(args["todos"])
    if name in ("edit", "write_file", "write_json", "append_file", "replace_all"):
        return _clip(str(args.get("path", "")), limit)
    if name == "shell":
        return _clip(str(args.get("command", "")), limit)
    parts = []
    for key, value in args.items():
        if value in (None, "", False):
            continue
        if isinstance(value, bool):
            parts.append(key)
            continue
        if isinstance(value, (list, dict)):
            value = "[%d]" % len(value)
        text = str(value)
        if any(ch.isspace() for ch in text) or text == "":
            text = json.dumps(text, ensure_ascii=False)
        parts.append("%s=%s" % (key, text))
    return _clip(" ".join(parts), limit)


def _clip(text, limit):
    text = " ".join(safe_text(text).split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def edit_diff(args, max_lines=3, width=72):
    """Short -/+ diff lines for an edit: [(sign, text), ...]."""
    out = []
    for sign, key in (("-", "search"), ("+", "replace")):
        lines = str((args or {}).get(key, "")).splitlines()
        for line in lines[:max_lines]:
            line = _display_file(str((args or {}).get("path", "")), line)
            out.append((sign, _clip(line, width) if line.strip() else line))
        if len(lines) > max_lines:
            out.append((sign, "… %d more line(s)" % (len(lines) - max_lines)))
    return out


def summarize_result(name, result):
    """(ok, one-line summary) for a tool result."""
    text = result or ""
    first = text.splitlines()[0] if text else ""
    if text.startswith("error:"):
        return False, _clip(first[len("error:"):].strip(), 90)
    if "denied by the user" in first:
        return False, "denied"
    if name == "read":
        match = re.search(r"\((\d+) lines\)", first)
        return True, ("%s lines" % match.group(1)) if match else _clip(first, 90)
    if name in ("glob", "search"):
        if text.strip() == "no matches":
            return True, "no matches"
        count = len([l for l in text.splitlines() if l and not l.startswith("...")])
        return True, "%d match(es)" % count if name == "search" else "%d file(s)" % count
    if name == "list":
        if text.strip() == "(empty)":
            return True, "empty"
        return True, "%d entries" % len([l for l in text.splitlines() if not l.startswith("...")])
    if name == "shell":
        match = re.match(r"exit code (\S+)", first)
        code = match.group(1) if match else "?"
        body = [l for l in text.splitlines()[1:] if l.strip()]
        tail = (" · " + _clip(body[-1], 60)) if body else ""
        return code == "0", "exit %s%s" % (code, tail)
    if name == "websearch":
        return True, "%d result(s)" % len(re.findall(r"^\[\d+\]", text, re.M))
    if name == "browse":
        return True, "%d chars" % max(0, len(text) - len(first) - 1)
    if name in ("todo_write", "todo_read"):
        lines = [l for l in text.splitlines() if l.startswith("[")]
        done = len([l for l in lines if l.startswith("[x]")])
        return True, "plan %d/%d done" % (done, len(lines)) if lines else _clip(first, 90)
    return True, _clip(first, 90)


def run_tool(name, args, workpath, ctx):
    """Execute one tool action. Returns the plain-text result."""
    tool = TOOLS.get(name)
    if not tool:
        return "error: unknown tool %r (available: %s)" % (name, ", ".join(TOOLS))
    try:
        if args is not None and not isinstance(args, dict):
            return "error: tool arguments must be an object"
        return _truncate(tool["run"](workpath, args or {}, ctx))
    except Exception as exc:  # a tool must never kill the agent loop
        return safe_text("error: %s" % exc)
