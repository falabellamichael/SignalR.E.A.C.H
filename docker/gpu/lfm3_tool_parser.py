"""LFM3 XML tools with schema-constrained arguments and bounded whitespace."""
from vllm.tool_parsers import ToolParserManager
from vllm.tool_parsers.qwen3_engine_tool_parser import Qwen3EngineToolParser
from vllm.tool_parsers.tool_strict_level import ToolStrictLevel


def bound_schema_whitespace(value):
    """Restrict grammar whitespace, never whitespace inside string values."""
    if isinstance(value, dict):
        if value.get("type") == "json_schema":
            value["max_whitespace_cnt"] = 1
        # A JSON Schema can itself contain arbitrary data named type/json_schema.
        # Traverse structural-tag nodes only, not the tool's user-supplied schema.
        for key, child in value.items():
            if key != "json_schema":
                bound_schema_whitespace(child)
    elif isinstance(value, list):
        for child in value:
            bound_schema_whitespace(child)


@ToolParserManager.register_module("lfm3_xml")
class LFM3ToolParser(Qwen3EngineToolParser):
    def get_structural_tag(self, request, *, reasoning=False,
                           strict_level=ToolStrictLevel.AUTO):
        tag = super().get_structural_tag(
            request, reasoning=reasoning, strict_level=ToolStrictLevel.PARAMETER)
        if tag is None:
            return None
        value = tag.model_dump()
        bound_schema_whitespace(value)
        return type(tag).model_validate(value)
