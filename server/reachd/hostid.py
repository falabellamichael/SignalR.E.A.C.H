"""Host identity + secret sealing at rest.

The host is the machine that runs the relay and holds the signed-in CodeGPT
session. This module binds that role to ONE machine and encrypts the secrets
the host owns, so a copy of the install directory — or of ``config.json`` —
is useless anywhere else.

Two separate jobs:

* **Fingerprint** — a stable, non-secret id for this machine (macOS hardware
  UUID, Linux ``/etc/machine-id``, Windows ``MachineGuid``). Only its salted
  hash is ever written to disk.
* **Sealing** — secrets are encrypted with a key derived from the fingerprint
  via ``scrypt``. Nothing derived from the fingerprint is stored: a copied
  config yields ciphertext that cannot be opened off this machine.

Design notes:

* This is *not* DRM and not obfuscation. Anyone with the source can read this
  file. It stops a copied install from *working*, which is the actual goal.
* The fingerprint is an INPUT to a KDF, never a key. Knowing a machine's
  hardware UUID does not let you decrypt a config, because the per-install
  random ``salt`` is also required and is stored alongside the ciphertext —
  so an attacker needs both the file and the exact machine.
* A recovery file is written at install time so a hardware change can be
  recovered without losing the host.
"""

import base64
import hashlib
import hmac
import json
import os
import platform
import secrets
import subprocess
from pathlib import Path

SEALED_TAG = "__reach_sealed__"
SEAL_VERSION = 1

# scrypt cost: n=2**14 is ~16MB, a few ms on a modern laptop — enough to make
# brute-forcing a fingerprint-derived key expensive without slowing startup.
_SCRYPT_N = 2 ** 14
_SCRYPT_R = 8
_SCRYPT_P = 1
_KEY_LEN = 32


class HostIdentityError(RuntimeError):
    """Raised when the host fingerprint cannot be determined."""


def raw_machine_id():
    """Best-effort stable hardware id for this machine, or ``""``.

    Deliberately does NOT fall back to the hostname: hostnames are trivially
    changed, so a hostname-derived lock would protect nothing.
    """
    system = platform.system()
    try:
        if system == "Darwin":
            out = subprocess.run(
                ["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
                capture_output=True, text=True, timeout=5).stdout
            for line in out.splitlines():
                if "IOPlatformUUID" in line:
                    return line.split('"')[-2].strip()
        elif system == "Windows":
            try:
                import winreg  # type: ignore
                with winreg.OpenKey(
                        winreg.HKEY_LOCAL_MACHINE,
                        r"SOFTWARE\Microsoft\Cryptography") as key:
                    value, _ = winreg.QueryValueEx(key, "MachineGuid")
                    return str(value).strip()
            except Exception:
                return ""
        else:
            for candidate in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
                path = Path(candidate)
                if path.is_file():
                    return path.read_text(encoding="utf-8").strip()
    except Exception:
        return ""
    return ""


def machine_hint():
    """A short, non-secret marker identifying this machine's user+host.

    The tray compares against this so both components agree on the host
    without reimplementing hardware-id reads in JavaScript. It is NOT used
    for encryption — the tray only needs to recognise "is this mine?".
    """
    try:
        import getpass
        import socket
        return (getpass.getuser() or "") + "@" + (socket.gethostname() or "")
    except Exception:
        return ""


def fingerprint(salt=None):
    """A stable hex digest identifying this machine, bound to one install."""
    machine = raw_machine_id()
    if not machine:
        raise HostIdentityError(
            "Could not read a stable machine id on this system. Host binding "
            "needs a hardware UUID, /etc/machine-id, or MachineGuid.")
    material = (machine + "\x00" + (salt or "")).encode("utf-8")
    return hashlib.sha256(material).hexdigest()


def _derive_key(secret_material, salt):
    return hashlib.scrypt(secret_material.encode("utf8"),
                          salt=bytes.fromhex(salt),
                          n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P,
                          dklen=_KEY_LEN)


def _stream_xor(data, key, nonce):
    """Keystream via HMAC-SHA256 in counter mode.

    Stdlib-only (no AES without a dependency). HMAC as a PRF is a sound
    construction here, and the key itself is scrypt-derived.
    """
    out = bytearray()
    counter = 0
    while len(out) < len(data):
        block = hmac.new(key, nonce + counter.to_bytes(8, "big"),
                         hashlib.sha256).digest()
        out.extend(block)
        counter += 1
    return bytes(a ^ b for a, b in zip(data, out))


def seal(plaintext, secret_material, salt):
    """Encrypt a string for this host. Returns an envelope dict."""
    if not isinstance(plaintext, str) or not plaintext:
        return plaintext
    key = _derive_key(secret_material, salt)
    nonce = secrets.token_bytes(16)
    cipher = _stream_xor(plaintext.encode("utf-8"), key, nonce)
    # Authenticate so a tampered config fails loudly rather than decrypting to
    # garbage that then gets used as a live key.
    mac = hmac.new(key, nonce + cipher, hashlib.sha256).digest()
    return {
        SEALED_TAG: SEAL_VERSION,
        "salt": salt,
        "nonce": base64.b64encode(nonce).decode("ascii"),
        "data": base64.b64encode(cipher).decode("ascii"),
        "mac": base64.b64encode(mac).decode("ascii"),
    }


def is_sealed(value):
    return isinstance(value, dict) and value.get(SEALED_TAG) == SEAL_VERSION


def open_sealed(envelope, secret_material):
    """Decrypt an envelope. Raises ``HostIdentityError`` on mismatch/tamper."""
    if not is_sealed(envelope):
        return envelope
    try:
        key = _derive_key(secret_material, envelope["salt"])
        nonce = base64.b64decode(envelope["nonce"])
        cipher = base64.b64decode(envelope["data"])
        mac = base64.b64decode(envelope["mac"])
    except (KeyError, ValueError, TypeError) as exc:
        raise HostIdentityError("Sealed value is malformed.") from exc
    expected = hmac.new(key, nonce + cipher, hashlib.sha256).digest()
    if not hmac.compare_digest(expected, mac):
        raise HostIdentityError(
            "A sealed secret could not be opened on this machine. It was "
            "encrypted for a different host, or the file was modified.")
    return _stream_xor(cipher, key, nonce).decode("utf-8")


def new_salt():
    return secrets.token_hex(16)


def recovery_code(machine_material, salt):
    """A short human-typable code that proves possession of the host identity."""
    digest = hashlib.sha256(
        ("recovery\x00" + machine_material + "\x00" + salt).encode("utf-8")
    ).hexdigest().upper()
    grouped = "-".join(digest[i:i + 5] for i in range(0, 25, 5))
    return "REACH-" + grouped


def write_recovery(path, machine_material, salt, note=""):
    """Write the recovery file with owner-only permissions."""
    payload = {
        "note": note or "Keep this file. It recovers this host if hardware changes.",
        "code": recovery_code(machine_material, salt),
        "salt": salt,
    }
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return payload
