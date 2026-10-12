"""Explicit Studio agent addresses and metadata-only Tab suggestions.

Only the leading selector is parsed. The addressed prompt is never passed to a
shell-style parser, which would alter code, quoting and Windows paths.
"""

import re
import unicodedata


METADATA_SELECTORS = ("agents", "list", "help")
_KINDS = ("persona", "conversation")
_SAFE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z")


def _control(character):
    return unicodedata.category(character) == "Cc" or character in "\u2028\u2029"


def _validate_selector(selector):
    if not selector.strip() or any(_control(character) for character in selector):
        raise ValueError("Choose a valid Studio agent name or id after @.")
    prefix, separator, ident = selector.partition(":")
    if separator and prefix.casefold() in _KINDS and not _SAFE_ID.fullmatch(ident):
        raise ValueError("Use @persona:ID or @conversation:ID with an agent id from @agents.")
    return selector


def _quoted_selector(line, start, incomplete=False):
    characters, index = [], start + 1
    while index < len(line):
        character = line[index]
        if character == '"':
            return "".join(characters), index + 1, True
        if character == "\\" and index + 1 < len(line) and line[index + 1] in ('"', "\\"):
            characters.append(line[index + 1])
            index += 2
        else:
            characters.append(character)
            index += 1
    if incomplete:
        return "".join(characters), index, False
    raise ValueError('Close the quoted agent name before sending: @"Agent Name" message.')


def parse_agent_address(line):
    """Return ``(selector, body)`` or ``(None, unchanged_line)``.

    The selector excludes @; a bare @ returns an empty selector for the agent
    list. One whitespace separator is removed, with CRLF treated as one newline.
    All remaining prompt characters, including indentation, are preserved.
    """
    if not isinstance(line, str):
        raise ValueError("An agent address must be text.")
    start = len(line) - len(line.lstrip(" \t"))
    if start == len(line) or line[start] != "@":
        return None, line
    start += 1
    if start == len(line):
        return "", ""
    if line[start].isspace():
        return "", line[start + (2 if line[start:start + 2] == "\r\n" else 1):]
    if line[start] == '"':
        selector, end, _ = _quoted_selector(line, start)
        _validate_selector(selector)
        if end < len(line) and not line[end].isspace():
            raise ValueError('Put a space after the quoted agent name: @"Agent Name" message.')
    else:
        end = start
        while end < len(line) and not line[end].isspace():
            end += 1
        selector = line[start:end]
        if '"' in selector:
            raise ValueError('Quote the whole agent name when it contains quotes or spaces.')
        _validate_selector(selector)
    if end == len(line):
        return selector, ""
    separator = 2 if line[end:end + 2] == "\r\n" else 1
    return selector, line[end + separator:]


def _canonical_alias(source):
    if not isinstance(source, dict) or source.get("kind") not in _KINDS:
        raise ValueError("Studio agent metadata is invalid.")
    ident = source.get("id")
    if not isinstance(ident, str) or not _SAFE_ID.fullmatch(ident):
        raise ValueError("Studio agent metadata is invalid.")
    return "@" + source["kind"] + ":" + ident


def _quoted_alias(name):
    return '@"' + name.replace("\\", "\\\\").replace('"', '\\"') + '"'


def format_agent_alias(source, sources=()):
    """Format a selectable alias, using kind:id for unsafe or ambiguous names."""
    canonical = _canonical_alias(source)
    name = source.get("name")
    if (not isinstance(name, str) or not name or len(name) > 256 or name != name.strip()
            or any(_control(character) for character in name)):
        return canonical
    folded = name.casefold()
    if folded in METADATA_SELECTORS or folded.partition(":")[0] in _KINDS and ":" in name:
        return canonical
    selected = source["kind"], source["id"]
    for other in sources:
        if not isinstance(other, dict) or (other.get("kind"), other.get("id")) == selected:
            continue
        if (str(other.get("name") or "").casefold() == folded
                or str(other.get("id") or "").casefold() == folded):
            return canonical
    if any(character.isspace() for character in name) or '"' in name or "\\" in name:
        return _quoted_alias(name)
    return "@" + name


def _completion_prefix(buffer):
    """A selector being edited, or None once the cursor reaches its body."""
    if not isinstance(buffer, str):
        return None
    raw = buffer.lstrip(" \t")
    if not raw.startswith("@"):
        return None
    if raw.startswith('@"'):
        selector, end, closed = _quoted_selector(raw, 1, incomplete=True)
        if any(_control(character) for character in selector) or closed and end != len(raw):
            return None
        return raw
    if any(character.isspace() or _control(character) or character == '"' for character in raw[1:]):
        return None
    return raw


def complete_agent_token(text, buffer, sources):
    """Return editor-compatible replacements from projected metadata only.

    Both editors replace the final whitespace token. For an unfinished quoted
    name, return the candidate suffix after its earlier, already typed words.
    """
    prefix = _completion_prefix(buffer)
    if prefix is None or not isinstance(text, str) or not buffer.endswith(text):
        return []
    sources = list(sources or ())
    quoted = prefix.startswith('@"')
    aliases = [_quoted_alias(name) if quoted else "@" + name for name in METADATA_SELECTORS]
    for source in sources:
        try:
            alias = format_agent_alias(source, sources)
            if quoted and not alias.startswith('@"'):
                alias = _quoted_alias(alias[1:])
            aliases.append(alias)
            # A typed id or kind prefix can complete directly without crowding
            # the bare @ menu with several aliases for every agent.
            if prefix not in ("@", '@"'):
                canonical = _canonical_alias(source)
                aliases.append(_quoted_alias(canonical[1:]) if quoted else canonical)
                owners = {(other.get("kind"), other.get("id")) for other in sources
                          if isinstance(other, dict) and other.get("id") == source["id"]
                          and other.get("kind") in _KINDS}
                if len(owners) == 1:
                    raw_id = "@" + source["id"]
                    aliases.append(_quoted_alias(raw_id[1:]) if quoted else raw_id)
        except ValueError:
            continue
    immutable = buffer[:len(buffer) - len(text)] if text else buffer
    leading = len(buffer) - len(buffer.lstrip(" \t"))
    consumed = len(immutable) - leading
    if consumed < 0:
        return []
    matches = []
    for alias in sorted(set(aliases), key=str.casefold):
        comparable = alias
        if not quoted and alias.startswith('@"'):
            comparable = "@" + parse_agent_address(alias)[0]
        if comparable.casefold().startswith(prefix.casefold()):
            matches.append(alias[consumed:])
    return list(dict.fromkeys(matches))


def detected_agent_completions(text, buffer):
    """Read metadata only when Tab is pressed inside an initial @ selector."""
    if _completion_prefix(buffer) is None:
        return []
    try:
        import os
        from .studio_context import StudioContextManager
        sources = StudioContextManager(os.getcwd()).detect(refresh=True).get("sources", [])
    except (OSError, ValueError, TypeError):
        sources = []
    return complete_agent_token(text, buffer, sources)
