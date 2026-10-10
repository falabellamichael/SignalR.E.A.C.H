const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const http = require('node:http');
const { createCodegptInference } = require('../copilot/tray/codegpt-inference');
const { createBridgeHandler } = require('../copilot/tray/bridge');

const TOOLS = ['list', 'glob', 'read'].map(name => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: { path: { type: 'string' } } } } }));
const sse = frames => frames.map(f => 'data: ' + (typeof f === 'string' ? f : JSON.stringify(f)) + '\n\n').join('') + 'data: [DONE]\n\n';
const chunk = (delta, finish = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] });

// A fake CodeGPT sidecar + API: metadata GETs answer, the POST streams `body`.
function harness(body) {
    const sent = [];
    const request = async (url, payload, _headers, _signal, method) => {
        const reply = text => Object.assign(Readable.from([Buffer.from(text)]), { statusCode: 200 });
        if (method === 'GET') {
            if (url.endsWith('/api/session')) return reply(JSON.stringify({ accessToken: 't' }));
            if (url.endsWith('/version')) return reply('3.1.0');
            if (url.endsWith('/me')) return reply(JSON.stringify({ metering: 'credits' }));
        }
        sent.push(payload);
        return reply(body);
    };
    const infer = createCodegptInference({ request });
    return { sent, run: (extra = {}) => infer({ driverPort: 5000, model: 'm', provider: 'openai', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }], ...extra }) };
}

test('advertised tools are forwarded beside the response function', async () => {
    const h = harness(sse([chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'list', arguments: '{"path":""}' } }] }), chunk({}, 'tool_calls')]));
    const out = await h.run({ tools: TOOLS });
    assert.deepEqual(h.sent[0].tools.map(t => t.name), ['reach_response', 'list', 'glob', 'read']);
    assert.deepEqual(out.tool_calls, [{ id: 'c1', type: 'function', function: { name: 'list', arguments: '{"path":""}' } }]);
});

test('streamed tool-call deltas are assembled by index', async () => {
    const h = harness(sse([
        chunk({ tool_calls: [{ index: 0, id: 'a', function: { name: 'gl', arguments: '' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { name: 'ob', arguments: '{"pattern":' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"*.py"}' } }] }),
        chunk({}, 'tool_calls')]));
    const out = await h.run({ tools: [...TOOLS, { type: 'function', function: { name: 'glob2', parameters: {} } }] });
    assert.equal(out.tool_calls[0].function.name, 'glob');
    assert.equal(out.tool_calls[0].function.arguments, '{"pattern":"*.py"}');
});

test('parallel calls keep their order and ids', async () => {
    const h = harness(sse([
        chunk({ tool_calls: [{ index: 0, id: 'x', function: { name: 'list', arguments: '{}' } }, { index: 1, id: 'y', function: { name: 'read', arguments: '{"path":"a"}' } }] }),
        chunk({ tool_calls: [{ index: 2, id: 'z', function: { name: 'glob', arguments: '{"path":"*"}' } }] }),
        chunk({}, 'tool_calls')]));
    const out = await h.run({ tools: TOOLS, parallelToolCalls: true });
    assert.deepEqual(out.tool_calls.map(c => c.id), ['x', 'y', 'z']);
    assert.equal(h.sent[0].parallel_tool_calls, true);
});

test('follow-up assistant tool_calls and tool results are accepted', async () => {
    const h = harness(sse([chunk({ tool_calls: [{ index: 0, function: { name: 'reach_response', arguments: '{"response":"done"}' } }] }), chunk({}, 'tool_calls')]));
    const out = await h.run({ tools: TOOLS, messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'go' },
        { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'a.py' }] });
    assert.equal(out, 'done');
    const joined = JSON.stringify(h.sent[0].messages);
    assert.match(joined, /TOOL CALL c1 list/);
    assert.match(joined, /tool c1: SUPPLIED HISTORICAL OBSERVATION/);
});

test('an unadvertised native call degrades to the caller text protocol instead of a 502', async () => {
    const h = harness(sse([chunk({ tool_calls: [{ index: 0, function: { name: 'list', arguments: '{"path":""}' } }, { index: 1, function: { name: 'glob', arguments: '{"pattern":"*.json"}' } }] }), chunk({}, 'tool_calls')]));
    const out = await h.run({ messages: [{ role: 'system', content: 'emit\n```tool\n{"action": "search"}\n```' }, { role: 'user', content: 'go' }] });
    assert.equal(out, '```tool\n{"action":"list","path":""}\n```\n\n```tool\n{"action":"glob","pattern":"*.json"}\n```');
});

function bridgeCall(result, body) {
    const handler = createBridgeHandler(null, null, async (_t, opts) => { bridgeCall.opts = opts; return result; }, () => ({}), null, () => {});
    const server = http.createServer(handler);
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
        const req = http.request({ port: server.address().port, method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' } }, res => {
            let text = ''; res.on('data', d => { text += d; }); res.on('end', () => { server.close(); resolve(text); });
        });
        req.end(JSON.stringify(body));
    }));
}

test('bridge returns OpenAI tool_calls streamed and non-streamed', async () => {
    const result = { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list', arguments: '{}' } }, { id: 'c2', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }] };
    const body = { model: 'codegpt-eco-gpt-4o-mini', tools: TOOLS, parallel_tool_calls: true, messages: [{ role: 'user', content: 'go' }] };
    const plain = JSON.parse(await bridgeCall(result, body));
    assert.equal(plain.choices[0].finish_reason, 'tool_calls');
    assert.equal(plain.choices[0].message.tool_calls.length, 2);
    assert.equal(bridgeCall.opts.tools.length, 3);
    const streamed = (await bridgeCall(result, { ...body, stream: true })).split('\n\n').filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6)));
    const deltas = streamed.flatMap(e => e.choices[0].delta.tool_calls || []);
    assert.deepEqual(deltas.map(d => [d.index, d.id, d.function.name]), [[0, 'c1', 'list'], [1, 'c2', 'read']]);
    assert.equal(streamed.at(-1).choices[0].finish_reason, 'tool_calls');
});
