"""Regressions for the exact pinned template and Raycast automation schema."""

import copy
import contextlib
import io
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from jinja2 import Environment

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "docker/gpu"))
from patch_gemma_tool_template import MARKER, TEMPLATE_PATH, install_container_template, patch_source


class GemmaToolTemplateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = (ROOT / "tests/fixtures/gemma4_schema_template.jinja").read_text(encoding="utf-8")
        cls.tool = json.loads((ROOT / "tests/fixtures/raycast_automation_tool.json").read_text())

    def render(self, source, tool):
        return Environment().from_string(source).render(tools=[tool])

    def test_raycast_schedule_discriminator_is_visible(self):
        original = copy.deepcopy(self.tool)
        before = self.render(self.source, self.tool)
        after = self.render(patch_source(self.source), self.tool)
        self.assertNotIn("cron_expression", before)
        self.assertIn("cron_expression", after)
        self.assertIn('const:<|"|>once<|"|>', after)
        self.assertIn('const:<|"|>recurring<|"|>', after)
        self.assertIn('required:[<|"|>type<|"|>,<|"|>cron_expression<|"|>]', after)
        self.assertIn('const:<|"|>existing_chat<|"|>', after)
        self.assertIn("additionalProperties:false", after)
        self.assertEqual(self.tool, original)

    def test_nested_body_and_nullable_arrays_keep_constraints(self):
        tool = copy.deepcopy(self.tool)
        tool["function"]["parameters"] = {"type": "object", "properties": {
            "body": {"anyOf": [{"type": "null"}, {"type": "object", "properties": {
                "Message": {"$ref": "#/$defs/Message"}}, "required": ["Message"]}]},
            "values": {"type": "array", "items": {"type": ["string", "null"], "enum": ["READY", None]},
                       "minItems": 1, "maxItems": 3}},
            "$defs": {"Message": {"type": "object", "properties": {"subject": {"type": "string"}},
                                  "required": ["subject"]}}, "required": ["body"]}
        result = self.render(patch_source(self.source), tool)
        for value in ["anyOf:[", "required:[<|\"|>Message<|\"|>]", "$defs:{", "$ref:",
                      'type:[<|"|>STRING<|"|>,<|"|>NULL<|"|>]', "maxItems:3", "minItems:1",
                      'enum:[<|"|>READY<|"|>,null]']:
            self.assertIn(value, result)

    def test_root_unions_boolean_schemas_and_data_are_retained(self):
        tool = copy.deepcopy(self.tool)
        tool["function"]["parameters"] = {"type": "object", "properties": {"payload": True},
            "allOf": [{"if": {"properties": {"flag": {"const": True}}},
                       "then": {"required": ["payload"]}}], "additionalProperties": False,
            "default": {"type": "literal-data", "oneOf": [1, 2]}}
        result = self.render(patch_source(self.source), tool)
        for value in ["payload:true", "allOf:[", "if:{", "then:{", "additionalProperties:false",
                      '<|"|>type<|"|>:<|"|>literal-data<|"|>']:
            self.assertIn(value, result)

    def test_patch_is_idempotent_and_preserves_message_renderer(self):
        suffix = "\nUNCHANGED MEDIA REASONING TOOL HISTORY\n"
        result = patch_source(self.source + suffix)
        self.assertEqual(patch_source(result), result)
        self.assertTrue(result.endswith(suffix))
        self.assertEqual(result[result.index("{%- if 'response'"):],
                         (self.source + suffix)[(self.source + suffix).index("{%- if 'response'"):])

    def test_unknown_and_partial_patches_are_rejected(self):
        with self.assertRaises(RuntimeError):
            patch_source(self.source.replace("['description', 'type'", "['changed', 'type'", 1))
        with self.assertRaises(RuntimeError):
            patch_source(MARKER + self.source)

    def test_container_installation_is_verified_backed_up_and_idempotent(self):
        files = {TEMPLATE_PATH: self.source.encode()}

        def docker(*args, check=True):
            self.assertEqual(args[0], "cp")
            source, destination = args[1:]
            if source.startswith("reach-gemma:"):
                content = files.get(source.split(":", 1)[1])
                if content is None:
                    self.assertFalse(check)
                    return SimpleNamespace(returncode=1)
                Path(destination).write_bytes(content)
            else:
                files[destination.split(":", 1)[1]] = Path(source).read_bytes()
            return SimpleNamespace(returncode=0)

        self.assertTrue(install_container_template("reach-gemma", docker))
        self.assertEqual(files[TEMPLATE_PATH + ".before-schema-rendering"], self.source.encode())
        self.assertEqual(files[TEMPLATE_PATH], patch_source(self.source).encode())
        self.assertFalse(install_container_template("reach-gemma", docker))

    def test_recreated_container_is_patched_before_starting(self):
        import launch_services as launch
        events = []

        def docker(*args, **kwargs):
            events.append(args)
            return SimpleNamespace(returncode=1 if args[:2] == ("container", "inspect") else 0,
                                   stdout="container-id")

        def install(name, callback):
            events.append(("patch", name))
            return True

        with patch.object(launch, "docker", side_effect=docker), \
                patch.object(launch, "check_weights"), patch.object(launch, "wait_ready"), \
                patch.object(launch, "gemma_config_override", return_value=Path("/override.json")), \
                patch.object(Path, "is_file", return_value=True), \
                patch("patch_gemma_tool_template.install_container_template", side_effect=install), \
                patch("patch_gemma_tool_parser.install_container_parser", return_value=False), \
                contextlib.redirect_stdout(io.StringIO()):
            launch.start("gemma", {"models": [{"name": "gemma4-12b-qat", "repository": "probe"}]})
        create = next(event for event in events if event[0] == "create")
        self.assertNotIn("-d", create)
        self.assertIn("--max-model-len", create)
        self.assertEqual(create[create.index("--max-model-len") + 1], "131072")
        self.assertLess(events.index(("patch", "reach-gemma")), events.index(("start", "reach-gemma")))


if __name__ == "__main__":
    unittest.main()
