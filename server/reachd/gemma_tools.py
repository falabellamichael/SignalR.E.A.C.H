"""Preserve JSON Schema unions across the pinned Gemma Jinja renderer.

The GGUF template uses an unsupported map('upper') filter for array-item
type lists. Equivalent anyOf constraints avoid that branch without dropping
nullability, other types, sibling validation, or client-owned schema data.
"""

import copy


MAPS = {"properties", "patternProperties", "$defs", "definitions", "dependentSchemas"}
SINGLE = {"items", "additionalItems", "additionalProperties", "unevaluatedProperties",
          "unevaluatedItems", "contains", "propertyNames", "if", "then", "else", "not",
          "contentSchema"}
ARRAYS = {"allOf", "anyOf", "oneOf", "prefixItems"}
TYPES = {"array", "boolean", "integer", "null", "number", "object", "string"}


def _schema(schema):
    if not isinstance(schema, dict):
        return copy.deepcopy(schema)
    result = {}
    for key, value in schema.items():
        if key in MAPS and isinstance(value, dict):
            result[key] = {name: _schema(child) for name, child in value.items()}
        elif key == "dependencies" and isinstance(value, dict):
            result[key] = {name: _schema(child) if isinstance(child, dict)
                           else copy.deepcopy(child) for name, child in value.items()}
        elif key in SINGLE or key in ARRAYS:
            result[key] = [_schema(child) for child in value] if isinstance(value, list) else _schema(value)
        else:
            result[key] = copy.deepcopy(value)
    item = result.get("items")
    types = item.get("type") if isinstance(item, dict) else None
    if (isinstance(types, list) and types and all(isinstance(t, str) and t in TYPES for t in types)
            and ("anyOf" not in item or "allOf" not in item or isinstance(item["allOf"], list))):
        union = {"anyOf": [{"type": name} for name in types]}
        del item["type"]
        if "anyOf" in item:
            item.setdefault("allOf", []).append(union)
        else:
            item.update(union)
    return result


def compatible_tools(tools):
    if not isinstance(tools, list):
        return tools
    result = copy.deepcopy(tools)
    for tool in result:
        function = tool.get("function") if isinstance(tool, dict) else None
        if isinstance(function, dict) and "parameters" in function:
            function["parameters"] = _schema(function["parameters"])
    return result
