// The pinned GGUF template cannot map('upper') over array-item type lists.
// Use equivalent JSON Schema unions while preserving caller data/constraints.
const maps = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const single = new Set(['items', 'additionalItems', 'additionalProperties', 'unevaluatedProperties',
  'unevaluatedItems', 'contains', 'propertyNames', 'if', 'then', 'else', 'not', 'contentSchema']);
const arrays = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const types = new Set(['array', 'boolean', 'integer', 'null', 'number', 'object', 'string']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function schema(value) {
  if (!object(value)) return structuredClone(value);
  const result = Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (maps.has(key) && object(child)) return [key, Object.fromEntries(Object.entries(child).map(([name, node]) => [name, schema(node)]))];
    if (key === 'dependencies' && object(child)) return [key, Object.fromEntries(Object.entries(child).map(([name, node]) => [name, object(node) ? schema(node) : structuredClone(node)]))];
    if (single.has(key) || arrays.has(key)) return [key, Array.isArray(child) ? child.map(schema) : schema(child)];
    return [key, structuredClone(child)];
  }));
  const item = result.items;
  if (object(item) && Array.isArray(item.type) && item.type.length && item.type.every(type => types.has(type))
      && (!Object.hasOwn(item, 'anyOf') || !Object.hasOwn(item, 'allOf') || Array.isArray(item.allOf))) {
    const union = { anyOf: item.type.map(type => ({ type })) };
    delete item.type;
    if (Object.hasOwn(item, 'anyOf')) (item.allOf ||= []).push(union);
    else Object.assign(item, union);
  }
  return result;
}

export function compatibleGemmaTools(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map(tool => {
    const result = structuredClone(tool);
    if (object(result?.function) && Object.hasOwn(result.function, 'parameters')) {
      result.function.parameters = schema(result.function.parameters);
    }
    return result;
  });
}
