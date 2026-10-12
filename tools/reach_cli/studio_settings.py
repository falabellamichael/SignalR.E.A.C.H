"""Authenticated, loopback-only access to Studio's existing settings handlers."""

import json
import os
import re
import urllib.error
import urllib.request


class SettingsError(ValueError):
    pass


def bridge_path():
    return os.path.join(os.path.expanduser("~"), ".config", "reach-cli", "studio-bridge.json")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class StudioSettingsClient:
    def __init__(self, path=None):
        try:
            with open(path or bridge_path(), "r", encoding="utf-8") as handle:
                data = json.load(handle)
            url, token = data["url"], data["token"]
            match = re.fullmatch(r"http://127\.0\.0\.1:([0-9]{1,5})", url)
            if data.get("version") != 1 or not match or not 1 <= int(match[1]) <= 65535:
                raise ValueError()
            if not isinstance(token, str) or not re.fullmatch(r"[a-f0-9]{64}", token):
                raise ValueError()
        except (OSError, ValueError, KeyError, TypeError):
            raise SettingsError("Open a Studio version with CLI settings support, then retry /settings studio.") from None
        self.url, self._token = url, token
        # A proxy or redirect must never receive the local bridge credential.
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())

    def call(self, method, params=None):
        request = urllib.request.Request(self.url + "/call", method="POST",
            data=json.dumps({"method": method, "params": params or {}}, allow_nan=False).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + self._token})
        try:
            with self._opener.open(request, timeout=35 if method == "mcp.test" else 10) as response:
                raw = response.read(1048577)
            if len(raw) > 1048576:
                raise ValueError()
            envelope = json.loads(raw)
            if not isinstance(envelope, dict):
                raise ValueError()
        except urllib.error.HTTPError as error:
            error.close()
            raise SettingsError("Studio settings connection failed. Restart Studio and retry; no CLI settings were changed.") from None
        except (OSError, ValueError, urllib.error.URLError):
            raise SettingsError("Studio settings connection failed. Restart Studio and retry; no CLI settings were changed.") from None
        if envelope.get("ok") is not True:
            # The server provides sanitized errors; never print raw HTTP bodies.
            from .agent_tools_extra import safe_text
            raise SettingsError(safe_text(str(envelope.get("error") or "Studio rejected the settings change."), 500))
        result = envelope.get("result")
        if isinstance(result, dict) and result.get("ok") is False:
            from .agent_tools_extra import safe_text
            raise SettingsError(safe_text(str(result.get("err") or "Studio rejected the settings change."), 500))
        return result
