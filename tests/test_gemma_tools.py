"""Nullable array-item schemas remain equivalent and renderable for Gemma."""
import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from reachd.gemma_tools import compatible_tools
from reachd.model_routes import dispatch


class GemmaToolsTests(unittest.TestCase):
    def tool(self, item):
        return [{'type': 'function', 'function': {'name': 'echo_probe', 'parameters': {
            'type': 'object', 'properties': {'values': {'type': 'array', 'items': item}},
            'required': ['values'], 'additionalProperties': False}}}]

    def test_nullable_union_preserves_constraints_and_original_input(self):
        tools = self.tool({'type': ['string', 'null'], 'enum': ['READY', None], 'description': 'Keep both.'})
        original = copy.deepcopy(tools)
        adapted = compatible_tools(tools)
        item = adapted[0]['function']['parameters']['properties']['values']['items']
        self.assertEqual(item, {'enum': ['READY', None], 'description': 'Keep both.',
                                'anyOf': [{'type': 'string'}, {'type': 'null'}]})
        self.assertEqual(tools, original)
        self.assertFalse(adapted[0]['function']['parameters']['additionalProperties'])

    def test_existing_anyof_and_allof_remain_conjunctive(self):
        tools = self.tool({'type': ['string', 'null'], 'anyOf': [{'const': 'READY'}, {'const': None}],
                           'allOf': [{'not': {'const': 'BLOCKED'}}]})
        item = compatible_tools(tools)[0]['function']['parameters']['properties']['values']['items']
        self.assertEqual(item['anyOf'], tools[0]['function']['parameters']['properties']['values']['items']['anyOf'])
        self.assertEqual(item['allOf'], [{'not': {'const': 'BLOCKED'}},
                                         {'anyOf': [{'type': 'string'}, {'type': 'null'}]}])

    def test_schema_data_and_property_names_are_never_rewritten(self):
        data = {'items': {'type': ['string', 'null']}}
        tools = self.tool({'type': 'object', 'default': data, 'const': data, 'enum': [data],
                           'properties': {'items': {'type': 'string'}, 'type': {'type': 'array', 'items': {'type': ['number', 'null']}}}})
        item = compatible_tools(tools)[0]['function']['parameters']['properties']['values']['items']
        for key in ('default', 'const', 'enum'):
            self.assertEqual(item[key], tools[0]['function']['parameters']['properties']['values']['items'][key])
        self.assertEqual(item['properties']['items'], {'type': 'string'})
        self.assertEqual(item['properties']['type']['items']['anyOf'], [{'type': 'number'}, {'type': 'null'}])

    def test_only_gemma_dispatch_adapts_schema_and_keeps_tool_choice(self):
        tools = self.tool({'type': ['string', 'null']})
        payload = {'messages': [], 'tools': tools, 'tool_choice': 'auto'}
        for alias in ('gemma-4-12b-qat', 'minicpm5-2b'):
            _, result, _, _ = dispatch('gpu/' + alias, payload, None)
            self.assertEqual(result['tool_choice'], 'auto')
            self.assertEqual(result['tools'], compatible_tools(tools) if alias.startswith('gemma') else tools)
