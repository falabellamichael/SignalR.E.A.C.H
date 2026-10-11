'use strict';
/* MCP client connection tests. The settings panel is not involved: these
 * drive agent/mcp.cjs the way an agent run does. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFramedChannel, McpManager } = require('../agent/mcp.cjs');

function listen(server) {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/`));
  });
}

test('content-length frames are counted in bytes, and string ids still match', async () => {
  const readable = new PassThrough();
  const channel = createFramedChannel(readable, () => {});
  const first = channel.send('initialize', {}, 1000);
  const second = channel.send('tools/list', {}, 1000);
  const hello = JSON.stringify({ jsonrpc: '2.0', id: '1', result: { text: 'héllo' } });
  const tools = JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [] } });
  const frame = body => `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
  readable.write(Buffer.from(frame(hello) + frame(tools)));
  assert.equal((await first).text, 'héllo');
  assert.deepEqual(await second, { tools: [] });
  channel.close();
});

function writeServer(body) {
  const file = path.join(os.tmpdir(), `reach-mcp-${process.pid}-${Date.now()}.cjs`);
  fs.writeFileSync(file, body);
  return file;
}

const STDIO_SERVER = `'use strict';
if (process.env.FLOOD_STDERR === '1') process.stderr.write('Z'.repeat(200000));
let buf = '';
const write = message => process.stdout.write(JSON.stringify(message) + '\\n');
process.stdin.on('data', chunk => {
  buf += chunk.toString('utf8');
  for (;;) {
    const at = buf.indexOf('\\n');
    if (at === -1) return;
    const line = buf.slice(0, at).trim();
    buf = buf.slice(at + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.id == null) continue;
    if (message.method === 'initialize') {
      const version = message.params && message.params.protocolVersion;
      if (version === '2025-03-26' && process.env.REJECT_NEW === '1') {
        write({ jsonrpc: '2.0', id: String(message.id), error: { code: -32602, message: 'Unsupported protocol version' } });
      } else {
        write({ jsonrpc: '2.0', id: String(message.id), result: {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { name: 'stdio-fixture', version: '1' },
        } });
      }
    } else if (message.method === 'tools/list') {
      write({ jsonrpc: '2.0', id: String(message.id), result: { tools: [
        { name: 'list-files', description: 'List files', inputSchema: { type: 'object', properties: {} } },
        { name: 'list_files', description: 'Same name once sanitised', inputSchema: { type: 'object', properties: {} } },
      ] } });
    } else if (message.method === 'tools/call') {
      write({ jsonrpc: '2.0', id: String(message.id), result: { content: [{ type: 'text', text: 'called:' + message.params.name }] } });
    }
  }
});
`;

test('stdio handshake survives a stderr flood and calls the server by its original tool name', async t => {
  const file = writeServer(STDIO_SERVER);
  t.after(() => fs.rmSync(file, { force: true }));
  const manager = new McpManager({
    handshakeMs: 4000,
    getSettings: () => ({ mcpServers: [{ name: 'files', command: process.execPath, args: [file], env: { FLOOD_STDERR: '1' } }] }),
  });
  t.after(() => manager.closeAll());
  const descriptors = await manager.toolDescriptors();
  assert.deepEqual(descriptors.map(d => d.name), ['files__list_files']);
  const result = await manager.callTool('files__list_files', {});
  assert.equal(result.ok, true);
  assert.equal(result.text, 'called:list-files');
});

test('stdio falls back when the server rejects the newest protocol version', async t => {
  const file = writeServer(STDIO_SERVER);
  t.after(() => fs.rmSync(file, { force: true }));
  const manager = new McpManager({
    handshakeMs: 4000,
    getSettings: () => ({ mcpServers: [{ name: 'files', command: process.execPath, args: [file], env: { REJECT_NEW: '1' } }] }),
  });
  t.after(() => manager.closeAll());
  const status = await manager.test('files');
  assert.equal(status.status, 'ok', status.error);
  assert.equal(status.tools.length, 2);
});

test('a missing stdio command fails the row instead of hanging the handshake', async t => {
  const manager = new McpManager({
    handshakeMs: 2000,
    getSettings: () => ({ mcpServers: [{ name: 'missing', command: 'reach-mcp-no-such-bin', args: [] }] }),
  });
  t.after(() => manager.closeAll());
  const status = await manager.test('missing');
  assert.equal(status.status, 'error');
  assert.match(status.error, /command not found|not recognized|Cannot start MCP server/i);
});

test('http handshake sends initialized and retries an older protocol version', async t => {
  const versions = [];
  let initialized = false;
  let sessionOnList = '';
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const message = JSON.parse(raw || '{}');
      if (message.id == null) {
        if (message.method === 'notifications/initialized') initialized = true;
        res.writeHead(202);
        res.end();
        return;
      }
      if (message.method === 'initialize') {
        versions.push(message.params.protocolVersion);
        if (message.params.protocolVersion !== '2024-11-05') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: String(message.id), error: { code: -32602, message: 'Unsupported protocol version' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
          protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'http-fixture', version: '1' },
        } }));
        return;
      }
      if (!initialized) {
        res.writeHead(400);
        res.end('before initialization');
        return;
      }
      sessionOnList = req.headers['mcp-session-id'] || '';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: String(message.id), result: { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }] } })}\n\n`);
    });
  });
  const url = await listen(server);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const manager = new McpManager({
    handshakeMs: 4000,
    getSettings: () => ({ mcpServers: [{ name: 'remote', transport: 'http', url }] }),
  });
  t.after(() => manager.closeAll());
  const descriptors = await manager.toolDescriptors();
  assert.deepEqual(versions, ['2025-03-26', '2024-11-05']);
  assert.equal(sessionOnList, 'sess-1');
  assert.deepEqual(descriptors.map(d => d.name), ['remote__echo']);
});
