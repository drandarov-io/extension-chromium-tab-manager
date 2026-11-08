import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import WebSocket from 'ws';

const serverPath = fileURLToPath(new URL('../server/server.js', import.meta.url));
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const TOKEN = randomUUID();

const hmac = (token, ...parts) => createHmac('sha256', token).update(parts.join(':')).digest('hex');

// Returns a port that was free a moment ago. The server takes the next free port from it.
const freePort = async () => {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  return port;
};

// Reads the server log until it reports its port or an error.
const waitForLog = async (stderr, pattern) => {
  for await (const line of createInterface({ input: stderr })) {
    const match = line.match(pattern);
    if (match)
      return match;
  }
};

// Starts the server as an MCP client does.
const startServer = async (t, env = {}) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, TAB_MANAGER_TOKEN: TOKEN, TAB_MANAGER_PORT: String(await freePort()), ...env },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  const [, port, error] = await waitForLog(transport.stderr, /on ws:\/\/127\.0\.0\.1:(\d+)|(Ports .* are in use|TAB_MANAGER_TOKEN is not set)/);
  return { client, port: Number(port), error };
};

// Plays the extension: checks the proof of the server, proves the token, and then handler(method, params) answers each request.
// Returns the HTTP status of a refused connection.
const connectBrowser = async (t, port, handler = () => ({}), { origin = ORIGIN, token = TOKEN } = {}) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
  const status = await Promise.race([
    once(socket, 'open').then(() => t.after(() => socket.close())),
    once(socket, 'unexpected-response').then(([, res]) => {
      // ws reports the end of a refused connection as an error.
      socket.on('error', () => {}).terminate();
      return res.statusCode;
    }),
  ]);
  if (status)
    return { socket, status };

  const nonce = randomUUID();
  socket.send(JSON.stringify({ nonce }));
  const { nonce: serverNonce, proof } = JSON.parse((await once(socket, 'message'))[0]);
  assert.equal(proof, hmac(TOKEN, 'server', nonce, serverNonce));
  socket.send(JSON.stringify({ proof: hmac(token, 'extension', nonce, serverNonce) }));

  socket.on('message', async data => {
    const { id, method, params } = JSON.parse(data);
    try {
      socket.send(JSON.stringify({ id, result: await handler(method, params) }));
    } catch (error) {
      socket.send(JSON.stringify({ id, error: error.message }));
    }
  });
  return { socket, status };
};

test('lists the tools', async t => {
  const { client } = await startServer(t);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['add_tabs_to_group', 'create_tab_group', 'list_group_tabs', 'list_tab_groups', 'list_tabs', 'ungroup_tabs', 'update_tab_group']);
});

test('sends a tool call to the browser and returns its result', async t => {
  const { client, port } = await startServer(t);
  const calls = [];
  await connectBrowser(t, port, (method, params) => {
    calls.push({ method, params });
    return [{ id: 7, title: 'Seven' }];
  });

  const result = await client.callTool({ name: 'list_tabs', arguments: { text: 'sev' } });

  assert.deepEqual(calls, [{ method: 'list_tabs', params: { text: 'sev' } }]);
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), [{ id: 7, title: 'Seven' }]);
});

test('returns an error from the browser as a tool error', async t => {
  const { client, port } = await startServer(t);
  await connectBrowser(t, port, () => { throw new Error('No tab with id: 5.'); });
  const result = await client.callTool({ name: 'ungroup_tabs', arguments: { tabIds: [5] } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /No tab with id: 5\./);
});

test('rejects invalid input before it reaches the browser', async t => {
  const { client, port } = await startServer(t);
  const calls = [];
  await connectBrowser(t, port, method => calls.push(method));
  for (const args of [{ tabIds: [] }, { tabIds: [1], color: 'teal' }, { tabIds: ['1'] }]) {
    const result = await client.callTool({ name: 'create_tab_group', arguments: args });
    assert.equal(result.isError, true);
  }
  assert.deepEqual(calls, []);
});

test('waits for a browser that connects late, and fails when none connects', async t => {
  const { client, port } = await startServer(t, { TAB_MANAGER_CONNECT_TIMEOUT_MS: '1000' });

  const failed = await client.callTool({ name: 'list_tabs', arguments: {} });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /No browser is connected/);

  const late = client.callTool({ name: 'list_tabs', arguments: {} });
  await connectBrowser(t, port, () => ['late']);
  assert.deepEqual(JSON.parse((await late).content[0].text), ['late']);
});

test('returns a tool error when the browser does not answer or disconnects', async t => {
  const { client, port } = await startServer(t, { TAB_MANAGER_CALL_TIMEOUT_MS: '300' });
  const { socket } = await connectBrowser(t, port, () => new Promise(() => {}));

  const timedOut = await client.callTool({ name: 'list_tabs', arguments: {} });
  assert.equal(timedOut.isError, true);
  assert.match(timedOut.content[0].text, /did not answer/);

  const call = client.callTool({ name: 'list_tabs', arguments: {} });
  await once(socket, 'message');
  socket.close();
  const disconnected = await call;
  assert.equal(disconnected.isError, true);
  assert.match(disconnected.content[0].text, /disconnected before it answered/);
});

test('accepts only extension origins', async t => {
  const { port } = await startServer(t);
  assert.equal((await connectBrowser(t, port, undefined, { origin: 'https://example.com' })).status, 403);
  assert.equal((await connectBrowser(t, port, undefined, { origin: null })).status, 403);
  assert.equal((await connectBrowser(t, port)).status, undefined);
});

test('proves the token, and closes a connection that cannot prove it', async t => {
  const { client, port } = await startServer(t, { TAB_MANAGER_CONNECT_TIMEOUT_MS: '1000' });
  const { socket } = await connectBrowser(t, port, () => 'wrong', { token: 'other token' });

  const [code] = await once(socket, 'close');
  assert.equal(code, 4001);
  const result = await client.callTool({ name: 'list_tabs', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /No browser is connected/);
});

test('reports a missing token', async t => {
  const { client, error } = await startServer(t, { TAB_MANAGER_TOKEN: '' });
  assert.match(error, /TAB_MANAGER_TOKEN is not set/);
  const result = await client.callTool({ name: 'list_tabs', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /TAB_MANAGER_TOKEN is not set/);
});

test('keeps the first browser and closes the connection of a second one', async t => {
  const { client, port } = await startServer(t);
  await connectBrowser(t, port, () => 'first');
  const { socket } = await connectBrowser(t, port, () => 'second');

  const [code, reason] = await once(socket, 'close');
  assert.equal(code, 4000);
  assert.match(String(reason), /Another browser/);
  assert.equal(JSON.parse((await client.callTool({ name: 'list_tabs', arguments: {} })).content[0].text), 'first');
});

test('a second server takes the next port, and the server reports when all ports are in use', async t => {
  const first = await startServer(t);
  const second = await startServer(t, { TAB_MANAGER_PORT: String(first.port) });
  assert.equal(second.port, first.port + 1);

  const base = await freePort();
  for (let port = base; port < base + 10; port++) {
    const blocker = createServer().listen(port, '127.0.0.1');
    t.after(() => blocker.listening && blocker.close());
    // A port that another program uses is blocked as well.
    await once(blocker, 'listening').catch(() => {});
  }
  const { client, error } = await startServer(t, { TAB_MANAGER_PORT: String(base) });
  assert.match(error, /are in use/);
  const result = await client.callTool({ name: 'list_tabs', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /are in use/);
});

test('exits when the MCP client closes stdin', async () => {
  const child = spawn(process.execPath, [serverPath], { env: { ...process.env, TAB_MANAGER_TOKEN: TOKEN, TAB_MANAGER_PORT: String(await freePort()) }, stdio: ['pipe', 'ignore', 'pipe'] });
  await waitForLog(child.stderr, /Waiting for the browser extension/);
  child.stdin.end();
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
});
