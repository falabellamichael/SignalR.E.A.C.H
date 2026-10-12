"""CLI preferences and Studio's complete settings surface, with explicit scope."""

import json
import os
import shlex
import unicodedata

from . import session
from .studio_settings import SettingsError, StudioSettingsClient

# Only settings actually consumed by the Python runtime belong in this list.
# Studio budgeting always uses budget.schema from the running Studio process.
CLI_BUDGETS = {
    "maxTokens": (0, "Output tokens per request; 0 uses the provider default"),
    "requestTimeoutMs": (0, "Request timeout in milliseconds; 0 waits until stopped"),
    "retryLimit": (0, "Retries after a failed request; 0 disables retries"),
    "retryBaseMs": (1, "First retry delay in milliseconds"),
    "retryMaxMs": (1, "Maximum retry backoff in milliseconds"),
    "retryAfterCapMs": (0, "Maximum Retry-After wait; 0 honors the header exactly"),
    "maxRounds": (0, "Agent rounds; 0 runs until completion or Stop"),
    "codeContext": (None, "Include the existing workpath file listing in agent prompts"),
    "codeContextChars": (0, "Workpath context characters; 0 disables the listing"),
}
CONVERSATION_DEFAULTS = {"name": "CLI conversation", "approvals": "prompt", "reviewEdits": True}
SECTIONS = ("connection", "appearance", "mcp", "conversation", "budgeting")


def _json_value(text):
    try:
        return json.loads(text, parse_constant=lambda value: (_ for _ in ()).throw(ValueError()))
    except (ValueError, TypeError):
        if isinstance(text, str) and text.startswith(('"', '[', '{')):
            raise SettingsError("Use valid JSON for quoted text, arrays or objects; no changes were saved.") from None
        return text


def _split_words(text):
    # Quotes delimit words while Windows paths retain their backslashes.
    lexer = shlex.shlex(text, posix=True)
    lexer.whitespace_split = True
    lexer.commenters = ""
    lexer.escape = ""
    return list(lexer)


def _validate_conversation(patch):
    for key, value in patch.items():
        if key == "name" and isinstance(value, str) and value.strip() and len(value) <= 80 and not any(unicodedata.category(c).startswith("C") for c in value):
            continue
        if key == "approvals" and value in ("prompt", "auto-read", "auto-all"):
            continue
        if key == "reviewEdits" and isinstance(value, bool):
            continue
        raise SettingsError("Use name (1–80 characters), approvals (prompt|auto-read|auto-all), or reviewEdits (true|false).")


def _validate_budgets(patch):
    for key, value in patch.items():
        if key not in CLI_BUDGETS:
            raise SettingsError("Unknown CLI budget. /settings budgeting lists CLI options; /settings studio budgeting lists all Studio budgets.")
        minimum = CLI_BUDGETS[key][0]
        if minimum is None:
            valid = isinstance(value, bool)
        else:
            valid = isinstance(value, int) and not isinstance(value, bool) and minimum <= value <= 2147483647
        if not valid:
            raise SettingsError("%s requires %s." % (key, "true or false" if minimum is None else "a whole number from %d to 2147483647" % minimum))


def load_cli_settings(path=None):
    with session._CONFIG_LOCK:
        data = session._read_config(path or session.session_config_path())
    saved = data.get("settings", {})
    clean = {"conversation": dict(CONVERSATION_DEFAULTS), "budgets": {}}
    if not isinstance(saved, dict):
        return clean
    for group, validator in (("conversation", _validate_conversation), ("budgets", _validate_budgets)):
        values = saved.get(group, {})
        if not isinstance(values, dict):
            continue
        for key, value in values.items():
            try:
                validator({key: value})
                clean[group][key] = value
            except SettingsError:
                pass
    return clean


def effective_budgets(client):
    settings = getattr(client, "cli_settings", {})
    return dict(settings.get("budgets", {})) if isinstance(settings, dict) else {}


def apply_client_settings(client, args=None, path=None):
    client.cli_settings = load_cli_settings(path)
    with session._CONFIG_LOCK:
        raw = session._read_config(path or session.session_config_path())
    stored = raw.get("settings", {})
    stored = stored.get("conversation", {}) if isinstance(stored, dict) else {}
    client.cli_settings_explicit_conversation = set()
    if isinstance(stored, dict):
        for key, value in stored.items():
            try:
                _validate_conversation({key: value})
                client.cli_settings_explicit_conversation.add(key)
            except SettingsError:
                pass
    if not hasattr(client, "_settings_default_timeout"):
        client._settings_default_timeout = getattr(client, "timeout", 600)
    budgets = effective_budgets(client)
    if "requestTimeoutMs" in budgets:
        client.timeout = budgets["requestTimeoutMs"] / 1000.0 or None
    else:
        client.timeout = client._settings_default_timeout
    return client.cli_settings


def save_cli_settings(client, group, patch, path=None):
    validator = {"conversation": _validate_conversation, "budgets": _validate_budgets}.get(group)
    if validator is None:
        raise SettingsError("Unknown settings section.")
    validator(patch)
    target = path or session.session_config_path()
    try:
        with session._CONFIG_LOCK:
            data = session._read_config(target, strict=True)
            current = data.setdefault("settings", {})
            if not isinstance(current, dict) or not isinstance(current.get(group, {}), dict):
                raise ValueError()
            current.setdefault(group, {}).update(patch)
            session._write_config(target, data)
    except (OSError, ValueError, TypeError):
        raise SettingsError("Could not save CLI settings. Check the original config JSON and permissions; no change was applied to this session.") from None
    apply_client_settings(client, path=target)


def _show_value(output, key, value, help_text=""):
    from .agent_tools_extra import safe_text
    text = json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value
    output.line("  %-24s %s%s" % (key, safe_text(text), " · " + help_text if help_text else ""))


def print_overview(output):
    output.line("  settings sections · /settings edit opens the editor")
    output.line("  connection    /settings connection · endpoints, credentials, default model")
    output.line("  appearance    /settings appearance · layout, theme, companion")
    output.line("  mcp           /settings studio mcp · servers, transports, tools and testing")
    output.line("  conversation  /settings conversation · name, permissions, edit review")
    output.line("  budgeting     /settings budgeting · generation, retries, rounds and context")
    output.line("  Studio parity /settings studio · all five Studio sections, Jev and team budgets")
    output.line("  Studio controls edit the running Studio profile; CLI controls edit this CLI session.")


def _native(client, history, repl, section, argument, output):
    from . import commands
    tokens = argument.split(None, 2)
    action = tokens[0].lower() if tokens else ""
    if section == "connection":
        if not argument:
            output.line("  /settings connection list|add|edit|test|select|remove · same options as /endpoint")
            output.line("  /settings model ALIAS · /settings models · /settings workpath DIR")
            output.flush()
            return commands._cmd_endpoint(client, history, repl, "list")
        output.flush()
        return commands._cmd_endpoint(client, history, repl, argument)
    if section == "appearance":
        if tokens:
            subcommand = tokens[0]
            if subcommand not in ("layout", "theme", "pet"):
                raise SettingsError("Use /settings appearance layout|theme|pet VALUE.")
            output.flush()
            return commands.HANDLERS["/" + subcommand](client, history, repl, argument.split(None, 1)[1] if len(argument.split(None, 1)) > 1 else "")
        from .splash import layout_mode
        from .themes import current_theme
        _show_value(output, "layout", layout_mode(), "/settings appearance layout center|full")
        _show_value(output, "theme", current_theme().name, "/settings appearance theme NAME")
        _show_value(output, "pet", getattr(client, "pet", "cat"), "/settings appearance pet cat|owl|bulldog|pause|resume")
    elif section == "conversation":
        values = getattr(client, "cli_settings", load_cli_settings()).get("conversation", CONVERSATION_DEFAULTS)
        if action == "set" and len(tokens) == 3:
            save_cli_settings(client, "conversation", {tokens[1]: _json_value(tokens[2])})
            output.line("  Saved CLI conversation setting: " + tokens[1])
        elif not argument:
            for key, value in values.items():
                _show_value(output, key, value)
            output.line("  /settings conversation set name|approvals|reviewEdits VALUE")
            output.line("  approvals: prompt|auto-read|auto-all · reviewEdits: true|false")
            output.line("  /settings agent · /settings system TEXT · /settings model ALIAS")
        else:
            raise SettingsError("Use /settings conversation set FIELD VALUE.")
    elif section == "budgeting":
        if action == "set" and len(tokens) == 3:
            save_cli_settings(client, "budgets", {tokens[1]: _json_value(tokens[2])})
            output.line("  Saved CLI budget: " + tokens[1] + ". Applies to the next request/run.")
        elif action == "reset" and len(tokens) == 1:
            target = session.session_config_path()
            try:
                with session._CONFIG_LOCK:
                    data = session._read_config(target, strict=True)
                    if not isinstance(data.get("settings", {}), dict):
                        raise ValueError()
                    data.setdefault("settings", {})["budgets"] = {}
                    session._write_config(target, data)
            except (OSError, ValueError, TypeError):
                raise SettingsError("Could not reset budgets; original settings were preserved.") from None
            apply_client_settings(client)
            output.line("  CLI budgets reset to the existing runtime defaults.")
        elif not argument:
            budgets = effective_budgets(client)
            for key, (_minimum, help_text) in CLI_BUDGETS.items():
                _show_value(output, key, budgets.get(key, "runtime default"), help_text)
            output.line("  /settings budgeting set KEY VALUE · /settings budgeting reset")
            output.line("  /settings studio budgeting global · all 42 Studio budgets and presets")
        else:
            raise SettingsError("Use /settings budgeting set KEY VALUE or reset.")
    return commands.SlashResult()


def _call_display(bridge, method, params, output):
    result = bridge.call(method, params)
    output.line(json.dumps(result, indent=2, ensure_ascii=False))
    return result


def _save_studio(bridge, settings, patch):
    if settings.get("settingsRevision"):
        patch = dict(patch, settingsRevision=settings["settingsRevision"])
    return bridge.call("settings.save", {"patch": patch})


def _find(records, identity):
    matches = [record for record in records if identity in (record.get("id"), record.get("name"))]
    if len(matches) != 1:
        raise SettingsError("Choose an unambiguous saved id/name from the section list.")
    return matches[0]


def _secret_from_env(name):
    if not isinstance(name, str) or not name.isascii() or not name.replace("_", "a").isalnum() or name[0:1].isdigit():
        raise SettingsError("Provide an existing environment-variable name; keys cannot be pasted into slash commands.")
    value = os.environ.get(name)
    if not value:
        raise SettingsError("That environment variable is empty or unset in this CLI process.")
    return value


def _studio_connections(bridge, settings, argument, output):
    from .agent_tools_extra import safe_text
    from .endpoints import normalize_url
    tokens = _split_words(argument)
    action = tokens[0] if tokens else "list"
    records = settings.get("connections", [])
    # Status-only fields are never persisted back as credentials.
    clean = [{key: value for key, value in row.items() if key in ("id", "name", "endpoint", "model", "enabled")} for row in records]
    if action == "list":
        for row in records:
            output.line(safe_text("  %s · %s · %s · model %s · %s · key %s%s" % (row["id"], row["name"], row["endpoint"], row.get("model") or "default", "in pool" if row.get("enabled", True) else "out of pool", "set" if row.get("hasAccessKey") else "none", " · active" if row["id"] == settings.get("activeConnection") else "")))
        output.line("  /settings studio connection add NAME URL [MODEL]")
        output.line("  /settings studio connection set ID name|endpoint|model|enabled VALUE")
        output.line("  /settings studio connection select|remove|models|test ID · test all")
        output.line("  /settings studio key ID ENV_NAME|clear · /settings studio key jev ENV_NAME|clear")
        output.line("  /settings studio set reachCli|jevEnabled|jevAutoMode VALUE")
        for key in ("reachCli", "jevEnabled", "jevAutoMode", "jevKeySource"):
            _show_value(output, key, settings.get(key, ""))
        return
    if action == "add" and len(tokens) in (3, 4):
        clean.append({"name": tokens[1], "endpoint": normalize_url(tokens[2]), "model": tokens[3] if len(tokens) == 4 else "", "enabled": True})
    elif action == "set" and len(tokens) >= 4:
        row = _find(clean, tokens[1])
        key, value = tokens[2], _json_value(argument.split(None, 3)[3])
        if key not in ("name", "endpoint", "model", "enabled"):
            raise SettingsError("Editable connection fields: name, endpoint, model, enabled.")
        if key == "endpoint":
            value = normalize_url(value)
        if key == "enabled" and not isinstance(value, bool):
            raise SettingsError("enabled requires true or false.")
        row[key] = value
    elif action in ("remove", "select", "models", "test") and len(tokens) == 2:
        if action == "test" and tokens[1] == "all":
            for row in records:
                _call_display(bridge, "connections.test", {"connectionId": row["id"]}, output)
            return
        row = _find(clean, tokens[1])
        if action in ("models", "test"):
            _call_display(bridge, "connections." + action, {"connectionId": row["id"]}, output)
            return
        if action == "select":
            _save_studio(bridge, settings, {"activeConnection": row["id"]})
            output.line("  Saved Studio active connection.")
            return
        clean.remove(row)
    else:
        raise SettingsError("See /settings studio connection for connection commands.")
    _save_studio(bridge, settings, {"connections": clean})
    output.line("  Saved Studio connections. Existing omitted keys were preserved.")


def _studio_mcp(bridge, settings, argument, output):
    from .agent_tools_extra import safe_text
    tokens = _split_words(argument)
    action = tokens[0] if tokens else "list"
    records = [{key: value for key, value in row.items() if key in ("id", "name", "enabled", "transport", "command", "args", "cwd", "url")} for row in settings.get("mcpServers", [])]
    if action in ("list", "status"):
        _call_display(bridge, "mcp.status", {}, output)
        for row in records:
            output.line(safe_text("  %s · %s · %s · %s" % (row["name"], "enabled" if row.get("enabled", True) else "disabled", row.get("transport", "stdio"), row.get("command") or row.get("url", ""))))
        output.line("  /settings studio mcp add NAME stdio COMMAND [ARGS...] | add NAME http URL")
        output.line("  /settings studio mcp set NAME enabled|transport|command|args|cwd|url VALUE")
        output.line("  /settings studio mcp add-file PATH | edit-file NAME PATH · JSON server object")
        output.line("  /settings studio mcp test|remove NAME · file env/headers support @env:ENV_NAME")
        return
    if action == "test" and len(tokens) == 2:
        row = _find(records, tokens[1])
        _call_display(bridge, "mcp.test", {"id": row.get("id") or row["name"]}, output)
        return
    if action == "add" and len(tokens) >= 4:
        transport = tokens[2]
        if transport == "stdio":
            row = {"name": tokens[1], "transport": transport, "command": tokens[3], "args": tokens[4:], "enabled": True}
        elif transport == "http" and len(tokens) == 4:
            from .endpoints import normalize_url
            row = {"name": tokens[1], "transport": transport, "url": normalize_url(tokens[3]), "enabled": True}
        else:
            raise SettingsError("MCP transport must be stdio or http.")
        if any(item["name"] == row["name"] for item in records):
            raise SettingsError("That server exists; use set or edit-file.")
        records.append(row)
    elif action == "set" and len(tokens) >= 4:
        row = _find(records, tokens[1])
        key, value = tokens[2], _json_value(argument.split(None, 3)[3])
        if key not in ("enabled", "transport", "command", "args", "cwd", "url"):
            raise SettingsError("Use edit-file for environment variables or headers.")
        if key == "url":
            from .endpoints import normalize_url
            value = normalize_url(value)
        row[key] = value
    elif action == "remove" and len(tokens) == 2:
        records.remove(_find(records, tokens[1]))
    elif action in ("add-file", "edit-file") and len(tokens) == (2 if action == "add-file" else 3):
        try:
            with open(os.path.expanduser(tokens[-1]), "r", encoding="utf-8") as handle:
                raw = handle.read(262145)
            if len(raw) > 262144:
                raise ValueError()
            patch = json.loads(raw)
            if not isinstance(patch, dict):
                raise ValueError()
            allowed = {"name", "enabled", "transport", "command", "args", "env", "cwd", "url", "headers"}
            if set(patch) - allowed:
                raise ValueError()
            for key in ("env", "headers"):
                if key in patch:
                    if not isinstance(patch[key], dict):
                        raise ValueError()
                    patch[key] = {name: _secret_from_env(value[5:]) if isinstance(value, str) and value.startswith("@env:") else value for name, value in patch[key].items()}
        except (OSError, ValueError, TypeError):
            raise SettingsError("Read a valid JSON MCP server object from the file; file contents were not printed.") from None
        if action == "edit-file":
            _find(records, tokens[1]).update(patch)
        else:
            if any(item["name"] == patch.get("name") for item in records):
                raise SettingsError("That server exists; use edit-file.")
            records.append(patch)
    else:
        raise SettingsError("See /settings studio mcp for server commands.")
    _save_studio(bridge, settings, {"mcpServers": records})
    output.line("  Saved Studio MCP servers. Omitted environment/header values were preserved.")


def _studio_budgets(bridge, argument, output):
    tokens = argument.split(None, 3)
    scope = tokens[0] if tokens else "global"
    schema = bridge.call("budget.schema")
    settings = bridge.call("settings.get")
    conversation = bridge.call("conversations.get", {"id": scope}) if scope != "global" else None
    if scope != "global" and not conversation:
        raise SettingsError("Conversation not found; choose an id from /settings studio conversation list.")
    values = {**schema["defaults"], **(settings.get("budgets") or {})}
    if conversation:
        local = conversation.get("settings", {})
        if not settings.get("budgets"):
            values.update({key: local[key] for key in ("maxTokens", "maxRounds") if isinstance(local.get(key), int) and not isinstance(local[key], bool) and local[key] >= 0})
        global_only = {field["key"] for field in schema["fields"] if field.get("globalOnly")}
        values.update({key: value for key, value in (local.get("budgetOverrides") or {}).items() if key not in global_only})
    action = tokens[1] if len(tokens) > 1 else ""
    if not action:
        output.line("  Studio budget scope: " + scope)
        if conversation:
            output.line("  " + ("Inherits global budgets" if not conversation.get("settings", {}).get("budgetOverrides") else "Conversation overrides"))
        group = None
        for field in schema["fields"]:
            if group != field["group"]:
                group = field["group"]
                output.line("  " + group)
            _show_value(output, field["key"], values[field["key"]], field["label"] + (" (global only)" if field.get("globalOnly") else ""))
        output.line("  /settings studio budgeting global|CONVERSATION_ID set KEY VALUE")
        output.line("  /settings studio budgeting SCOPE preset balanced|heavy|unrestricted")
        output.line("  /settings studio budgeting CONVERSATION_ID inherit · /settings studio engines")
        output.line("  /settings studio budgeting SCOPE help KEY shows the exact zero semantics.")
        return
    if action == "help" and len(tokens) == 3:
        field = next((field for field in schema["fields"] if field["key"] == tokens[2]), None)
        if not field:
            raise SettingsError("Unknown Studio budget.")
        output.line(field["label"] + ": " + field["help"])
        return
    overrides = {} if action == "inherit" and scope != "global" else None
    if action == "set" and len(tokens) == 4:
        field = next((field for field in schema["fields"] if field["key"] == tokens[2]), None)
        if not field or scope != "global" and field.get("globalOnly"):
            raise SettingsError("Unknown budget or a global-only setting in conversation scope.")
        value = _json_value(tokens[3])
        valid = isinstance(value, bool) if field["type"] == "boolean" else isinstance(value, int) and not isinstance(value, bool) and field["min"] <= value <= 2147483647
        if not valid:
            raise SettingsError("Enter a valid %s for %s (minimum %s)." % (field["type"], field["key"], field["min"]))
        overrides = dict(settings.get("budgets") or {}) if scope == "global" else dict(conversation.get("settings", {}).get("budgetOverrides") or {})
        overrides[field["key"]] = value
    elif action == "preset" and len(tokens) == 3 and tokens[2] in schema["presets"]:
        overrides = {key: value for key, value in schema["presets"][tokens[2]].items() if scope == "global" or not next(field for field in schema["fields"] if field["key"] == key).get("globalOnly")}
    elif action != "inherit" or scope == "global" or len(tokens) != 2:
        raise SettingsError("Use set KEY VALUE, preset balanced|heavy|unrestricted, or conversation inherit.")
    if scope == "global":
        _save_studio(bridge, settings, {"budgets": overrides})
    else:
        patch = {"settings": {"budgetOverrides": None if action == "inherit" else overrides}}
        if conversation.get("conversationRevision"):
            patch["conversationRevision"] = conversation["conversationRevision"]
        bridge.call("conversations.update", {"id": scope, "patch": patch})
    output.line("  Saved Studio budgets. New runs use the changed budgets.")


def _studio(argument, output):
    bridge = StudioSettingsClient()
    parts = argument.split(None, 1)
    section = parts[0].lower() if parts else ""
    rest = parts[1] if len(parts) > 1 else ""
    if section == "budgeting":
        _studio_budgets(bridge, rest, output)
        return
    if section == "engines":
        _call_display(bridge, "engines.report", {}, output)
        return
    if section == "conversation":
        tokens = rest.split(None, 3)
        action = tokens[0] if tokens else "list"
        if action == "list" and len(tokens) <= 1:
            _call_display(bridge, "conversations.list", {}, output)
        elif action == "get" and len(tokens) == 2:
            _call_display(bridge, "conversations.get", {"id": tokens[1]}, output)
        elif action == "set" and len(tokens) == 4:
            key, value = tokens[2], _json_value(tokens[3])
            if key in ("name", "approvals", "reviewEdits"):
                _validate_conversation({key: value})
            elif key != "model" or not isinstance(value, str):
                raise SettingsError("Editable conversation fields: name, model, approvals, reviewEdits.")
            patch = {key: value} if key in ("name", "model") else {"settings": {key: value}}
            current = bridge.call("conversations.get", {"id": tokens[1]})
            if not current:
                raise SettingsError("Conversation not found; choose an id from the section list.")
            if current.get("conversationRevision"):
                patch["conversationRevision"] = current["conversationRevision"]
            bridge.call("conversations.update", {"id": tokens[1], "patch": patch})
            output.line("  Saved Studio conversation setting.")
        else:
            raise SettingsError("Use /settings studio conversation list|get ID|set ID FIELD VALUE.")
        output.line("  /settings studio conversation get ID | set ID name|model|approvals|reviewEdits VALUE")
        return
    settings = bridge.call("settings.get")
    if not section:
        output.line("  REACH Studio settings · edits apply to the running Studio profile")
        warning = (settings.get("credentialStorage") or {}).get("warning")
        if warning:
            from .agent_tools_extra import safe_text
            output.line("  " + safe_text(warning))
        for name, detail in (("connection", "connections, model, pool, compiler and Jev"), ("appearance", "page layout, theme, accent and tint"), ("mcp", "stdio/HTTP servers, environment, headers and tool tests"), ("conversation", "conversation name, model, approval permissions and file review"), ("budgeting", "42 shared budget fields, global/conversation scope and presets")):
            output.line("  /settings studio %-14s %s" % (name, detail))
        output.line("  /settings studio key jev|CONNECTION_ID ENV_NAME|clear")
        return
    if section == "connection":
        _studio_connections(bridge, settings, rest, output)
    elif section == "mcp":
        _studio_mcp(bridge, settings, rest, output)
    elif section in ("set", "appearance"):
        text = rest[4:] if section == "appearance" and rest.startswith("set ") else rest
        tokens = text.split(None, 1)
        if section == "appearance" and not text:
            for key in ("pageLayout", "theme", "accent", "tint"):
                _show_value(output, key, settings.get(key, ""))
            if settings.get("themeOptions"):
                output.line("  themes: " + ", ".join(theme["id"] for theme in settings["themeOptions"]))
            output.line("  /settings studio appearance set pageLayout|theme|accent|tint VALUE")
            output.line("  pageLayout: page-sized|full-width · tint: 0–100 · accent: #rrggbb or empty")
            return
        allowed = ("pageLayout", "theme", "accent", "tint") if section == "appearance" else ("reachCli", "jevEnabled", "jevAutoMode")
        if len(tokens) != 2 or tokens[0] not in allowed:
            raise SettingsError("Choose a listed field and value for this section.")
        key, value = tokens[0], _json_value(tokens[1])
        if key in ("theme", "accent", "tint"):
            bridge.call("theme.set", {key: value})
        else:
            _save_studio(bridge, settings, {key: value})
        output.line("  Saved Studio " + key + ".")
    elif section == "key":
        tokens = rest.split()
        if len(tokens) != 2:
            raise SettingsError("Use /settings studio key jev|CONNECTION_ID ENV_NAME|clear.")
        key = "" if tokens[1] == "clear" else _secret_from_env(tokens[1])
        if tokens[0] == "jev":
            patch = {"jevApiKeyAction": "clear"} if tokens[1] == "clear" else {"jevApiKey": key}
        else:
            row = _find(settings.get("connections", []), tokens[0])
            records = [{name: value for name, value in item.items() if name in ("id", "name", "endpoint", "model", "enabled")} for item in settings["connections"]]
            _find(records, row["id"])["accessKey"] = key
            patch = {"connections": records}
        _save_studio(bridge, settings, patch)
        output.line("  Studio key %s; secret values are never displayed or stored in CLI history." % ("cleared" if tokens[1] == "clear" else "saved through its credential store"))
    else:
        raise SettingsError("Studio sections: connection, appearance, mcp, conversation, budgeting; also set, key, engines.")


def handle_settings(client, history, repl, argument, output):
    from . import commands, terminal
    try:
        if argument.strip() in ("edit", "menu"):
            print_overview(output)
            output.flush()
            while True:
                try:
                    line = terminal.read_input("  settings > ").strip()
                except (KeyboardInterrupt, EOFError):
                    break
                if not line or line.lower() in ("back", "cancel", "exit", "q"):
                    break
                line = line[len("/settings "):] if line.startswith("/settings ") else line
                if line in ("edit", "menu"):
                    continue
                if line in ("help", "list"):
                    print_overview(output)
                    output.flush()
                    continue
                handle_settings(client, history, repl, line, output)
                output.flush()
            return commands.SlashResult()
        parts = argument.split(None, 1)
        section = parts[0].lower() if parts else ""
        rest = parts[1] if len(parts) > 1 else ""
        if section == "studio" or section == "mcp":
            _studio(rest if section == "studio" else "mcp " + rest, output)
        elif section in SECTIONS:
            return _native(client, history, repl, section, rest, output)
        elif section in ("model", "models", "agent", "system", "workpath", "layout", "theme", "pet"):
            output.flush()
            return commands.HANDLERS["/" + section](client, history, repl, rest)
        else:
            raise SettingsError("Use /settings connection|appearance|conversation|budgeting|studio, or /settings edit.")
        return commands.SlashResult()
    except (SettingsError, ValueError, TypeError, KeyError) as error:
        # No raw provider bodies, JSON objects or credential-bearing inputs.
        message = str(error) if isinstance(error, SettingsError) else "Invalid settings command. Check the listed fields, argument types and quoted values."
        output.line(terminal.c_yellow("  " + message))
        return commands.SlashResult(success=False)
