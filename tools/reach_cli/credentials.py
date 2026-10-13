"""Resolve named credentials without exposing or persisting their values."""

import os


def _windows_environment_value(name):
    """Read one named Windows environment value, in User then Machine order."""
    try:
        import winreg
    except ImportError:
        return ""
    locations = (
        (winreg.HKEY_CURRENT_USER, "Environment"),
        (winreg.HKEY_LOCAL_MACHINE,
         r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
    )
    for hive, path in locations:
        try:
            with winreg.OpenKey(hive, path) as registry:
                value, kind = winreg.QueryValueEx(registry, name)
        except OSError:
            continue
        if not isinstance(value, str) or kind not in (winreg.REG_SZ, winreg.REG_EXPAND_SZ):
            return ""
        if kind == winreg.REG_EXPAND_SZ:
            try:
                value = winreg.ExpandEnvironmentStrings(value)
            except OSError:
                return ""
        return value.strip()
    return ""


def environment_value(name):
    """Use the current process override, then a saved Windows environment value.

    Explicitly empty process variables stay empty. Only absent references
    consult Windows storage, so a terminal opened before a key was saved can
    use it without changing the process environment or the CLI config.
    """
    if not isinstance(name, str) or not name:
        return ""
    if name in os.environ:
        return os.environ[name].strip()
    return _windows_environment_value(name) if os.name == "nt" else ""
