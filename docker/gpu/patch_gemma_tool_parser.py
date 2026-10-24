"""Preserve bare JSON scalar types in the pinned Gemma4 native parser.

Quoted Gemma strings remain strings. Bare numbers, booleans and null must
keep their types even inside schema references or object unions, where the
upstream schema-coercion pass does not descend. Partial-value withholding
and streaming boundaries remain unchanged.
"""

import argparse
from pathlib import Path

from patch_gemma_tool_template import install_container_file


PARSER_PATH = "/usr/local/lib/python3.12/dist-packages/vllm/parser/gemma4.py"
LITERAL_HELPER = '''def _parse_gemma4_literal(raw_value: str):
    """Decode complete bare scalars; delimited strings use the existing path."""
    try:
        value = json.loads(raw_value)
    except (ValueError, TypeError):
        return raw_value
    if value is None or isinstance(value, (bool, int)):
        return value
    if isinstance(value, float) and math.isfinite(value):
        return value
    return raw_value


'''


def patch_source(source):
    edits = [("import json\n", "import json\nimport math\n"),
             ("def _parse_gemma4_args(", LITERAL_HELPER + "def _parse_gemma4_args("),
             ("            result[key] = raw_val\n", "            result[key] = _parse_gemma4_literal(raw_val)\n"),
             ("            items.append(raw_val)\n", "            items.append(_parse_gemma4_literal(raw_val))\n")]
    if "def _parse_gemma4_literal(" in source:
        expected = ["import math\n", "            result[key] = _parse_gemma4_literal(raw_val)\n",
                    "            items.append(_parse_gemma4_literal(raw_val))\n"]
        if source.count(LITERAL_HELPER) != 1 or any(source.count(fragment) != 1 for fragment in expected):
            raise RuntimeError("Unrecognized Gemma literal patch; preserving its parser")
        return source
    for before, _ in edits:
        if source.count(before) != 1:
            raise RuntimeError("Unrecognized Gemma literal parser; preserving its source")
    result = source
    for before, after in edits:
        result = result.replace(before, after, 1)
    compile(result, "gemma4.py", "exec")
    return result


def install_container_parser(name, docker):
    return install_container_file(name, docker, PARSER_PATH, patch_source, ".before-reach-literals")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path)
    args = parser.parse_args()
    original = args.path.read_bytes()
    result = patch_source(original.decode()).encode()
    if result == original:
        print("Gemma scalar preservation already installed")
        return
    backup = args.path.with_name(args.path.name + ".before-reach-literals")
    if backup.exists() and backup.read_bytes() != original:
        raise RuntimeError("Existing Gemma parser backup differs; preserving both files")
    if not backup.exists():
        backup.write_bytes(original)
    args.path.write_bytes(result)
    print("Gemma native scalar types preserved")


if __name__ == "__main__":
    main()
