#!/usr/bin/env node
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebSocketServer } from 'ws';
import { createMcpServer } from './tools.js';

// The extension creates the token, and its popup copies it into the MCP server config.
const TOKEN = process.env.TAB_MANAGER_TOKEN;

// The extension tries all ports in this range, so that more than one MCP client can run at the same time.
const FIRST_PORT = Number(process.env.TAB_MANAGER_PORT ?? 17890);
const PORT_COUNT = 10;
const CONNECT_TIMEOUT_MS = Number(process.env.TAB_MANAGER_CONNECT_TIMEOUT_MS ?? 40_000);
const CALL_TIMEOUT_MS = Number(process.env.TAB_MANAGER_CALL_TIMEOUT_MS ?? 30_000);
const HANDSHAKE_TIMEOUT_MS = 5_000;

// stdout carries the MCP messages, so all logs go to stderr.
const log = message => process.stderr.write(`[tab-manager] ${message}\n`);

const withTimeout = (promise, ms, message) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => timer = setTimeout(() => reject(new Error(message)), ms))])
    .finally(() => clearTimeout(timer));
};

// The WebSocket of the connected browser, and the requests that wait for its answer, by ID.
let browser;
let connected = Promise.withResolvers();
let startError = TOKEN ? undefined : new Error('TAB_MANAGER_TOKEN is not set. Copy the MCP server config from the popup of the Tab Manager MCP extension.');
const pending = new Map();
let nextId = 1;

const call = async (method, params) => {
  if (startError)
    throw startError;
  const socket = browser ?? await withTimeout(connected.promise, CONNECT_TIMEOUT_MS,
      'No browser is connected. Install the Tab Manager MCP extension, switch it on, and open its popup to connect now.');

  const id = nextId++;
  const { promise, resolve, reject } = Promise.withResolvers();
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
  return withTimeout(promise, CALL_TIMEOUT_MS, `The browser did not answer within ${CALL_TIMEOUT_MS / 1000} seconds.`)
    .finally(() => pending.delete(id));
};

const onBrowser = socket => {
  if (browser)
    return socket.close(4000, 'Another browser is already connected to this MCP server.');

  browser = socket;
  connected.resolve(socket);
  log('The browser connected.');

  socket.on('message', data => {
    try {
      const { id, result, error } = JSON.parse(data);
      if (error !== undefined)
        pending.get(id)?.reject(new Error(error));
      else
        pending.get(id)?.resolve(result);
    } catch (error) {
      log(`The browser sent a message that is not JSON: ${error.message}`);
    }
  });
  socket.on('close', () => {
    browser = undefined;
    connected = Promise.withResolvers();
    for (const { reject } of pending.values())
      reject(new Error('The browser disconnected before it answered.'));
    log('The browser disconnected.');
  });
};

// HMAC-SHA256 in hex of the parts, with the token as key. The extension computes the same.
const hmac = (...parts) => createHmac('sha256', TOKEN).update(parts.join(':')).digest('hex');

// The extension sends a nonce, the server proves that it has the token, and then the extension proves it.
// The token never goes over the connection, and the extension answers no server that cannot prove it.
const authenticate = async socket => {
  const signal = AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS);
  const receive = async () => JSON.parse((await once(socket, 'message', { signal }))[0]);
  const serverNonce = randomUUID();
  const { nonce } = await receive();
  socket.send(JSON.stringify({ nonce: serverNonce, proof: hmac('server', nonce, serverNonce) }));
  const { proof } = await receive();
  // Each connection has new nonces, so the time that the comparison takes tells nothing.
  return proof === hmac('extension', nonce, serverNonce);
};

// Only extensions can connect. Browsers set the Origin header, and web pages cannot change it.
const wss = new WebSocketServer({ noServer: true });
const httpServer = createServer((req, res) => res.writeHead(426).end());
const onSocketError = error => log(`Connection error: ${error.message}`);

httpServer.on('upgrade', (req, socket, head) => {
  socket.on('error', onSocketError);
  if (!req.headers.origin?.startsWith('chrome-extension://')) {
    log(`Refused a connection from origin ${req.headers.origin ?? '(none)'}.`);
    return socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  }
  socket.off('error', onSocketError);
  wss.handleUpgrade(req, socket, head, async ws => {
    if (await authenticate(ws).catch(() => false))
      return onBrowser(ws);
    log('Refused a connection without the token. If it is your browser, copy the MCP server config from the extension popup again.');
    ws.close(4001, 'The token does not match.');
  });
});

const listen = port => new Promise((resolve, reject) => {
  httpServer.once('error', reject);
  httpServer.listen(port, '127.0.0.1', () => {
    httpServer.off('error', reject);
    resolve();
  });
});

await createMcpServer(call).connect(new StdioServerTransport());

// The MCP client closes stdin when it stops the server. The open port would keep the process alive.
process.stdin.on('end', () => process.exit(0));

for (let port = FIRST_PORT; !startError; port++) {
  try {
    await listen(port);
    log(`Waiting for the browser extension on ws://127.0.0.1:${port}.`);
    break;
  } catch (error) {
    if (error.code === 'EADDRINUSE' && port < FIRST_PORT + PORT_COUNT - 1)
      continue;
    startError = new Error(error.code === 'EADDRINUSE'
      ? `Ports ${FIRST_PORT} to ${port} are in use, for example by other MCP clients that run Tab Manager MCP. Close one of them.`
      : `The server cannot listen on port ${port}: ${error.message}`);
  }
}
if (startError)
  log(startError.message);
