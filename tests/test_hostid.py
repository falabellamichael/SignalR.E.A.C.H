#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Tests for host binding + secret sealing (stdlib-only, unittest).
Run:  python -m unittest tests.test_hostid -v
  or: python tests/test_hostid.py

The property under test is narrow and important: secrets written by a host
install must NOT be usable on any other machine, while remaining perfectly
readable on the machine that wrote them.
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

from reachd import hostid  # noqa: E402
from reachd import settings as S  # noqa: E402


class HostIdCryptoTests(unittest.TestCase):
    def setUp(self):
        self.salt = hostid.new_salt()
        self.material = "TEST-MACHINE-UUID" + "\x00" + self.salt

    def test_seal_roundtrip(self):
        secret = "sk-reach-abcdef0123456789abcdef0123456789"
        env = hostid.seal(secret, self.material, self.salt)
        self.assertTrue(hostid.is_sealed(env))
        self.assertEqual(hostid.open_sealed(env, self.material), secret)

    def test_ciphertext_is_not_plaintext(self):
        secret = "sk-super-secret-value"
        env = hostid.seal(secret, self.material, self.salt)
        # The raw envelope must not contain the secret in any obvious form.
        self.assertNotIn(secret, json.dumps(env))

    def test_wrong_machine_cannot_open(self):
        env = hostid.seal("sk-secret", self.material, self.salt)
        other = "A-DIFFERENT-MACHINE" + "\x00" + self.salt
        with self.assertRaises(hostid.HostIdentityError):
            hostid.open_sealed(env, other)

    def test_tampered_ciphertext_is_rejected(self):
        import base64
        env = hostid.seal("sk-secret-value", self.material, self.salt)
        raw = bytearray(base64.b64decode(env["data"]))
        raw[0] ^= 0x01
        env = dict(env, data=base64.b64encode(bytes(raw)).decode("ascii"))
        with self.assertRaises(hostid.HostIdentityError):
            hostid.open_sealed(env, self.material)

    def test_wrong_salt_cannot_open(self):
        # Same machine, different install salt -> different key. This is what
        # keeps two installs on ONE machine from opening each other's config.
        env = hostid.seal("sk-secret", self.material, self.salt)
        other_salt = hostid.new_salt()
        with self.assertRaises(hostid.HostIdentityError):
            hostid.open_sealed(env, "TEST-MACHINE-UUID" + "\x00" + other_salt)

    def test_plain_values_pass_through(self):
        self.assertEqual(hostid.open_sealed("not-sealed", self.material),
                         "not-sealed")
        self.assertIsNone(hostid.open_sealed(None, self.material))

    def test_recovery_code_is_stable_and_prefixed(self):
        a = hostid.recovery_code(self.material, self.salt)
        b = hostid.recovery_code(self.material, self.salt)
        self.assertEqual(a, b)
        self.assertTrue(a.startswith("REACH-"))
        c = hostid.recovery_code("OTHER-MACHINE" + "\x00" + self.salt, self.salt)
        self.assertNotEqual(a, c)

    def test_fingerprint_is_salt_dependent(self):
        f1 = hostid.fingerprint(self.salt)
        f2 = hostid.fingerprint(hostid.new_salt())
        self.assertNotEqual(f1, f2)


class HostSealedConfigTests(unittest.TestCase):
    """End-to-end: what lands on disk, and who can read it back."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.cfg_path = self.tmp / "config.json"

    def _write(self, machine="HOST-MACHINE", upstream="sk-upstream-SECRET-1"):
        with patch.object(hostid, "raw_machine_id", lambda: machine):
            cfg = S.load_config(self.cfg_path)
            cfg["omniroute_key"] = upstream
            S.save_config(cfg, self.cfg_path)
            return cfg

    def test_secrets_are_sealed_on_disk(self):
        self._write()
        raw = json.loads(self.cfg_path.read_text())
        self.assertTrue(hostid.is_sealed(raw["omniroute_key"]))
        self.assertTrue(hostid.is_sealed(raw["system"]["admin_token"]))
        self.assertTrue(hostid.is_sealed(raw["access"]["keys"][0]["key"]))

    def test_no_plaintext_secret_on_disk(self):
        self._write()
        text = self.cfg_path.read_text()
        self.assertNotIn("sk-upstream-SECRET-1", text)

    def test_same_host_reads_its_own_secrets(self):
        real = self._write()
        client_key = real["access"]["keys"][0]["key"]
        with patch.object(hostid, "raw_machine_id", lambda: "HOST-MACHINE"):
            again = S.load_config(self.cfg_path)
        self.assertEqual(again["omniroute_key"], "sk-upstream-SECRET-1")
        self.assertEqual(again["access"]["keys"][0]["key"], client_key)
        self.assertNotIn("_host_error", again)

    def test_other_host_is_refused_and_blanked(self):
        self._write()
        with patch.object(hostid, "raw_machine_id", lambda: "SOMEONE-ELSES-PC"):
            other = S.load_config(self.cfg_path)
        # The mismatch is reported rather than silently swallowed...
        self.assertIn("_host_error", other)
        # ...and no ciphertext leaks through as if it were a usable secret.
        self.assertEqual(other["omniroute_key"], "")

    def test_host_salt_and_hint_are_minted(self):
        with patch.object(hostid, "raw_machine_id", lambda: "HOST-MACHINE"):
            cfg = S.load_config(self.cfg_path)
        self.assertTrue(cfg["system"]["host_salt"])
        self.assertTrue(cfg["system"]["host_bind"])

    def test_host_bind_off_stores_plaintext(self):
        # Opting out must actually opt out, or the escape hatch is a lie.
        with patch.object(hostid, "raw_machine_id", lambda: "HOST-MACHINE"):
            cfg = S.load_config(self.cfg_path)
            cfg["system"]["host_bind"] = False
            cfg["omniroute_key"] = "sk-plain-2"
            S.save_config(cfg, self.cfg_path)
        raw = json.loads(self.cfg_path.read_text())
        self.assertFalse(hostid.is_sealed(raw["omniroute_key"]))
        self.assertEqual(raw["omniroute_key"], "sk-plain-2")

    def test_legacy_plaintext_config_still_loads(self):
        # An install written before sealing must not break on upgrade.
        legacy = json.loads(json.dumps(S.DEFAULT_SETTINGS))
        legacy["system"]["admin_token"] = "rt-plaintexttoken"
        legacy["omniroute_key"] = "sk-legacy-plain"
        self.cfg_path.write_text(json.dumps(legacy))
        with patch.object(hostid, "raw_machine_id", lambda: "HOST-MACHINE"):
            cfg = S.load_config(self.cfg_path)
        self.assertEqual(cfg["omniroute_key"], "sk-legacy-plain")
        self.assertEqual(cfg["system"]["admin_token"], "rt-plaintexttoken")


if __name__ == "__main__":
    unittest.main()
