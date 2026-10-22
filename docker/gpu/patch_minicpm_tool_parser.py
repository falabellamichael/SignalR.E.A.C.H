"""Patch the pinned MiniCPM parser's handling of Raycast display metadata.

Run against the installed vLLM parser inside the MiniCPM container, then
restart only that container. Actual tool inputs remain schema-validated.
"""

import argparse
import hashlib
from pathlib import Path


ORIGINAL = '''    req_props = name_to_required.get(func_name, set())
    if req_props and not req_props.issubset(arguments.keys()):
        return None
'''
PATCHED = '''    req_props = name_to_required.get(func_name, set())
    # Raycast's required display label is UI metadata, not a tool input.
    # Supply only this label when omitted; never invent required tool inputs.
    display_key = "__raycast_tool_call_description"
    if display_key in req_props and display_key not in arguments:
        arguments[display_key] = (
            func_name.rsplit("__", 1)[-1].replace("-", " ").replace("_", " ").capitalize()
        )
    if req_props and not req_props.issubset(arguments.keys()):
        return None
'''


def patch_source(source):
    if source.count(PATCHED) == 1:
        return source
    if source.count(ORIGINAL) != 1:
        raise RuntimeError("Unrecognized MiniCPM parser; preserving its source")
    result = source.replace(ORIGINAL, PATCHED, 1)
    compile(result, "minicpm5xml_tool_parser.py", "exec")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path, help="Installed minicpm5xml_tool_parser.py")
    args = parser.parse_args()
    original = args.path.read_bytes()
    result = patch_source(original.decode("utf-8")).encode("utf-8")
    if result == original:
        print("MiniCPM Raycast display metadata patch already installed")
        return
    backup = args.path.with_name(args.path.name + ".before-raycast-description")
    if backup.exists() and backup.read_bytes() != original:
        raise RuntimeError("Existing parser backup differs; preserving both files")
    if not backup.exists():
        backup.write_bytes(original)
    args.path.write_bytes(result)
    print("MiniCPM parser patched; SHA256=" + hashlib.sha256(result).hexdigest())


if __name__ == "__main__":
    main()
