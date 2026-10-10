"""Custom endpoint records in the existing CLI session configuration.

This module never connects to endpoints or stores API keys. ``key_env`` is an
environment-variable name, resolved only when a client uses that record.
"""

import copy
import ipaddress
import os
import re
import unicodedata
import urllib.parse

from .session import _CONFIG_LOCK, _UNSET, _read_config, _write_config, session_config_path


LOCAL_ENDPOINT_URL = "http://127.0.0.1:20777/v1"
BUILTIN_NAMES = ("local", "subscription", "public")
RESERVED_NAMES = frozenset(BUILTIN_NAMES + (
    "add", "edit", "update", "remove", "delete", "rm", "list", "ls", "show",
    "get", "select", "use", "test", "check", "help", "models", "settings",
    "endpoint", "endpoints"))
UNSET = _UNSET
_NAME = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
_ENV = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")
_BAD_ESCAPE = re.compile(r"%(?![0-9a-fA-F]{2})")


class EndpointError(ValueError):
    """A safe, actionable endpoint configuration error; never contains secrets."""


def _has_controls(value):
    return any(unicodedata.category(char) in ("Cc", "Cf", "Cs") for char in value)


def normalize_name(value):
    if not isinstance(value, str) or _has_controls(value):
        raise EndpointError("Endpoint names must be 1-64 letters, numbers, underscores or hyphens, starting with a letter.")
    name = value.strip().lower()
    if not _NAME.fullmatch(name):
        raise EndpointError("Endpoint names must be 1-64 letters, numbers, underscores or hyphens, starting with a letter.")
    if name in RESERVED_NAMES:
        raise EndpointError("That name is reserved for a built-in endpoint or command. Choose a custom name.")
    return name


def normalize_url(value):
    """Validate an HTTP(S) base URL without ever reflecting unsafe input."""
    if not isinstance(value, str) or not value or len(value) > 4096 or _has_controls(value):
        raise EndpointError("Endpoint URL must be an HTTP(S) base URL without control characters.")
    value = value.strip()
    if any(char.isspace() for char in value) or "\\" in value or "?" in value or "#" in value:
        raise EndpointError("Use an HTTP(S) base URL without whitespace, credentials, query parameters or fragments.")
    if _BAD_ESCAPE.search(value):
        raise EndpointError("Endpoint URL contains an invalid percent escape.")
    decoded = value
    # Include encoded and double-encoded terminal controls in the same policy.
    for _ in range(8):
        try:
            next_decoded = urllib.parse.unquote(decoded, errors="strict")
        except UnicodeError:
            raise EndpointError("Endpoint URL contains invalid encoded text.")
        if _has_controls(next_decoded) or "\\" in next_decoded:
            raise EndpointError("Endpoint URL contains encoded control characters.")
        if next_decoded == decoded:
            break
        decoded = next_decoded
    else:
        raise EndpointError("Endpoint URL has excessive nested percent encoding.")
    try:
        parts = urllib.parse.urlsplit(value)
        if parts.scheme.lower() not in ("http", "https") or not parts.netloc or not parts.hostname:
            raise ValueError()
        if parts.username is not None or parts.password is not None or "@" in parts.netloc:
            raise EndpointError("Endpoint URLs cannot contain credentials. Use --key-env with an environment-variable name.")
        port = parts.port
        if port is not None and not 1 <= port <= 65535 or parts.netloc.endswith(":"):
            raise ValueError()
        host = parts.hostname
        if "%" in host:
            raise ValueError()
        if ":" in host:
            ipaddress.IPv6Address(host)
            authority = "[%s]" % host.lower()
        else:
            host = host.encode("idna").decode("ascii").lower()
            labels = host.rstrip(".").split(".")
            if len(host) > 253 or any(
                    not label or len(label) > 63 or
                    not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?", label)
                    for label in labels):
                raise ValueError()
            authority = host
        if port is not None:
            authority += ":%d" % port
        return urllib.parse.urlunsplit((parts.scheme.lower(), authority, parts.path.rstrip("/"), "", ""))
    except EndpointError:
        raise
    except (ValueError, UnicodeError):
        raise EndpointError("Endpoint URL needs a valid HTTP(S) host and port (1-65535).")


def normalize_key_env(value):
    if value is None or value == "":
        return None
    if not isinstance(value, str) or not _ENV.fullmatch(value):
        raise EndpointError("--key-env must name an environment variable, such as MY_API_KEY; do not enter an API key.")
    return value


def _records(config):
    stored = config.get("custom_endpoints", {})
    if not isinstance(stored, dict):
        raise EndpointError("custom_endpoints must be a JSON object. Repair the config before editing endpoints; no changes were saved.")
    records = {}
    for name, record in stored.items():
        normalized = normalize_name(name)
        if normalized in records:
            raise EndpointError("The config has duplicate endpoint names differing only in case. Repair the config before editing endpoints.")
        if not isinstance(record, dict) or "url" not in record or set(record) - {"url", "key_env"}:
            raise EndpointError("An endpoint record is incompatible. Use only url and an optional key_env reference; no changes were saved.")
        clean = {"url": normalize_url(record["url"])}
        key_env = normalize_key_env(record.get("key_env"))
        if key_env:
            clean["key_env"] = key_env
        records[normalized] = clean
    return {name: records[name] for name in sorted(records)}


def _config(path):
    try:
        config = _read_config(path, strict=True)
    except ValueError as exc:
        raise EndpointError(str(exc))
    for field in ("endpoint", "endpoint_name", "model", "workpath", "layout"):
        if field in config and not isinstance(config[field], str):
            raise EndpointError("A saved session field is incompatible. Repair the config before editing endpoints; no changes were saved.")
    return config, _records(config)


def _persist(path, config, records):
    config["custom_endpoints"] = records
    try:
        _write_config(path, config)
    except (OSError, TypeError, ValueError):
        raise EndpointError("Could not save endpoint configuration. Check the config directory permissions; no endpoint change was committed.")


def list_custom(path=None):
    path = path or session_config_path()
    with _CONFIG_LOCK:
        _current, records = _config(path)
        return copy.deepcopy(records)


def get_custom(name, path=None):
    name = normalize_name(name)
    records = list_custom(path)
    if name not in records:
        raise EndpointError("Custom endpoint not found. Run /endpoints to see available names.")
    return records[name]


def add_custom(name, url, key_env=None, path=None):
    name = normalize_name(name)
    record = {"url": normalize_url(url)}
    reference = normalize_key_env(key_env)
    if reference:
        record["key_env"] = reference
    path = path or session_config_path()
    with _CONFIG_LOCK:
        config, records = _config(path)
        if name in records:
            raise EndpointError("That custom endpoint already exists. Use /endpoint edit to change it.")
        records[name] = record
        _persist(path, config, records)
    return copy.deepcopy(record)


def _active(config, name, record):
    selected = config.get("endpoint_name")
    if isinstance(selected, str) and selected.strip():
        return selected.strip().lower() == name
    # Legacy saved URLs can identify custom endpoints, but never a built-in.
    try:
        saved = normalize_url(config.get("endpoint"))
    except EndpointError:
        return False
    return saved != LOCAL_ENDPOINT_URL and saved == record["url"]


def edit_custom(name, url=None, key_env=UNSET, path=None):
    name = normalize_name(name)
    validated_url = normalize_url(url) if url is not None else None
    reference = normalize_key_env(key_env) if key_env is not UNSET else UNSET
    path = path or session_config_path()
    with _CONFIG_LOCK:
        config, records = _config(path)
        if name not in records:
            raise EndpointError("Custom endpoint not found. Run /endpoints to see available names.")
        old = records[name]
        record = dict(old)
        if validated_url is not None:
            record["url"] = validated_url
        if reference is not UNSET:
            if reference:
                record["key_env"] = reference
            else:
                record.pop("key_env", None)
        if _active(config, name, old):
            config["endpoint_name"] = name
            config["endpoint"] = record["url"]
            if record["url"] != old["url"]:
                config.pop("model", None)
        records[name] = record
        _persist(path, config, records)
    return copy.deepcopy(record)


def select_custom(name, path=None):
    name = normalize_name(name)
    path = path or session_config_path()
    with _CONFIG_LOCK:
        config, records = _config(path)
        if name not in records:
            raise EndpointError("Custom endpoint not found. Run /endpoints to see available names.")
        record = records[name]
        if not _active(config, name, record):
            config.pop("model", None)
        config["endpoint"] = record["url"]
        config["endpoint_name"] = name
        _persist(path, config, records)
    return copy.deepcopy(record)


def remove_custom(name, path=None):
    name = normalize_name(name)
    path = path or session_config_path()
    with _CONFIG_LOCK:
        config, records = _config(path)
        if name not in records:
            raise EndpointError("Custom endpoint not found. Run /endpoints to see available names.")
        record = records.pop(name)
        if _active(config, name, record):
            config["endpoint"] = "local"
            config["endpoint_name"] = "local"
            config.pop("model", None)
        _persist(path, config, records)
    return copy.deepcopy(record)


def credential_for(record):
    """Resolve a credential reference, never the built-in REACH_KEY fallback."""
    reference = normalize_key_env(record.get("key_env") if isinstance(record, dict) else None)
    return os.environ.get(reference, "").strip() if reference else ""
