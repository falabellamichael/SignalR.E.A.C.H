"""Preserve complete tool schemas in the pinned vLLM Gemma prompt template.

The upstream formatter drops unions, references, consts and other constraints,
and mistakes an object's oneOf for a property. Only schema rendering changes;
message history, reasoning, media and tool-call serialization stay untouched.
"""

import argparse
import hashlib
from pathlib import Path
import tempfile


TEMPLATE_PATH = "/app/vllm/examples/tool_chat_template_gemma4.jinja"
MARKER = "{#- REACH: preserve complete JSON Schema declarations v1 -#}"
MACRO_HASH = "aa1ff0b0828387fd63b83578271390f422460304b0e9195a7149dfa93fc5e4b1"
PARAMS_HASH = "8c499f1c78bae47627aa3a2936baa349cf75029af468b4bb7bbad7fba5ea096c"

SCHEMA_MACROS = MARKER + '''
{%- macro format_schema(schema) -%}
    {%- if schema is mapping -%}
        {{- '{' -}}
        {%- for key, value in schema | dictsort -%}
            {{- key -}}:
            {%- if key == 'type' and value is string -%}
                {{- format_argument(value | upper) -}}
            {%- elif key == 'type' and value is sequence -%}
                {{- '[' -}}
                {%- for item in value -%}
                    {{- format_argument(item | upper) -}}{{- ',' if not loop.last -}}
                {%- endfor -%}
                {{- ']' -}}
            {%- elif key in ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'] and value is mapping -%}
                {{- '{' -}}
                {%- for name, child in value | dictsort -%}
                    {{- name -}}:{{- format_schema(child) -}}{{- ',' if not loop.last -}}
                {%- endfor -%}
                {{- '}' -}}
            {%- elif key in ['allOf', 'anyOf', 'oneOf', 'prefixItems'] and value is sequence -%}
                {{- '[' -}}
                {%- for child in value -%}
                    {{- format_schema(child) -}}{{- ',' if not loop.last -}}
                {%- endfor -%}
                {{- ']' -}}
            {%- elif key in ['items', 'additionalItems', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'contains', 'propertyNames', 'if', 'then', 'else', 'not', 'contentSchema'] -%}
                {%- if value is sequence and value is not string and value is not mapping -%}
                    {{- '[' -}}
                    {%- for child in value -%}
                        {{- format_schema(child) -}}{{- ',' if not loop.last -}}
                    {%- endfor -%}
                    {{- ']' -}}
                {%- else -%}
                    {{- format_schema(value) -}}
                {%- endif -%}
            {%- else -%}
                {{- format_argument(value) -}}
            {%- endif -%}
            {{- ',' if not loop.last -}}
        {%- endfor -%}
        {{- '}' -}}
    {%- else -%}
        {{- format_argument(schema) -}}
    {%- endif -%}
{%- endmacro -%}
'''
PARAMS_BLOCK = '''    {%- set params = tool_data['function']['parameters'] -%}
    {%- if params -%}
        ,parameters:{{- format_schema(params) -}}
    {%- endif -%}
'''


def patch_source(source):
    if MARKER in source:
        if source.count(SCHEMA_MACROS) != 1 or source.count(PARAMS_BLOCK) != 1:
            raise RuntimeError("Unrecognized Gemma schema patch; preserving its template")
        return source
    start = source.find("{%- macro format_parameters(")
    end = source.find("{%- macro format_function_declaration(", start)
    params_start = source.find("    {%- set params = tool_data['function']['parameters'] -%}", end)
    params_end = source.find("    {%- if 'response' in tool_data['function'] -%}", params_start)
    if not 0 <= start < end < params_start < params_end:
        raise RuntimeError("Unrecognized Gemma template; preserving its source")
    for section, expected in ((source[start:end], MACRO_HASH),
                              (source[params_start:params_end], PARAMS_HASH)):
        if hashlib.sha256(section.encode()).hexdigest() != expected:
            raise RuntimeError("Unrecognized Gemma schema formatter; preserving its source")
    return (source[:start] + SCHEMA_MACROS + source[end:params_start]
            + PARAMS_BLOCK + source[params_end:])


def install_container_template(name, docker):
    """Works on created/stopped containers too, before vLLM reads the template."""
    return install_container_file(name, docker, TEMPLATE_PATH, patch_source, ".before-schema-rendering")


def install_container_file(name, docker, target, patcher, backup_suffix):
    """Install one guarded runtime patch and preserve its original bytes."""
    with tempfile.TemporaryDirectory(prefix="reach-gemma-schema-") as directory:
        path = Path(directory) / "template.jinja"
        docker("cp", f"{name}:{target}", str(path))
        original = path.read_bytes()
        result = patcher(original.decode("utf-8")).encode("utf-8")
        if result == original:
            return False
        backup = Path(directory) / "original.jinja"
        backup.write_bytes(original)
        saved = Path(directory) / "saved.jinja"
        existing = docker("cp", f"{name}:{target}{backup_suffix}", str(saved), check=False)
        if existing.returncode == 0 and saved.read_bytes() != original:
            raise RuntimeError("Existing Gemma template backup differs; preserving both files")
        if existing.returncode != 0:
            docker("cp", str(backup), f"{name}:{target}{backup_suffix}")
        path.write_bytes(result)
        docker("cp", str(path), f"{name}:{target}")
        docker("cp", f"{name}:{target}", str(saved))
        if saved.read_bytes() != result:
            raise RuntimeError("Gemma template installation did not verify")
        return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path, help="Installed tool_chat_template_gemma4.jinja")
    args = parser.parse_args()
    original = args.path.read_bytes()
    result = patch_source(original.decode("utf-8")).encode("utf-8")
    if result == original:
        print("Gemma complete-schema rendering already installed")
        return
    backup = args.path.with_name(args.path.name + ".before-schema-rendering")
    if backup.exists() and backup.read_bytes() != original:
        raise RuntimeError("Existing Gemma template backup differs; preserving both files")
    if not backup.exists():
        backup.write_bytes(original)
    args.path.write_bytes(result)
    print("Gemma schema rendering patched; SHA256=" + hashlib.sha256(result).hexdigest())


if __name__ == "__main__":
    main()
