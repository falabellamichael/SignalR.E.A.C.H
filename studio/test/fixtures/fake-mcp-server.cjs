'use strict';
/* Minimal MCP server fixture for tests: newline-delimited JSON-RPC 2.0 on
 * stdio. Speaks exactly what agent/mcp.cjs needs — initialize, tools/list,
 * tools/call — with no dependencies. Spawned by tests via
 * ELECTRON_RUN_AS_NODE=1 <electron> <this file>. */
let buf = '';
const write = message => process.stdout.write(JSON.stringify(message) + '\n');
process.stdin.on('data', chunk => {
  buf += chunk.toString('utf8');
  for (;;) {
    const at = buf.indexOf('\n');
    if (at === -1) return;
    const line = buf.slice(0, at).trim();
    buf = buf.slice(at + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.method === 'initialize') {
      write({ jsonrpc: '2.0', id: m.id, result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture-mcp', version: '1.0.0' },
      } });
    } else if (m.method === 'tools/list') {
      write({ jsonrpc: '2.0', id: m.id, result: { tools: [
        { name: 'echo', description: 'Echoes its input.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
      ] } });
    } else if (m.method === 'tools/call') {
      write({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: String(m.params?.arguments?.text || '') }] } });
    }
    // notifications (no id) need no reply
  }
});
