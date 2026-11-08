import { addToGroup, createGroup, listGroups, listGroupTabs, listTabs, ungroup, updateGroup } from './tabs.js';

// The MCP server listens on the first free port of this range. The storage can change the first port for tests.
const FIRST_PORT = 17890;
const PORT_COUNT = 10;

const methods = {
  list_tabs: listTabs,
  list_tab_groups: ({ windowId }) => listGroups(windowId),
  list_group_tabs: listGroupTabs,
  create_tab_group: createGroup,
  update_tab_group: updateGroup,
  add_tabs_to_group: addToGroup,
  ungroup_tabs: ungroup,
};

// Open and opening connections by port, the connections whose server proved the token, and the ports whose server has another token.
const sockets = new Map();
const authenticated = new Set();
const mismatched = new Set();
let message;

// The popup shows the status.
const setStatus = () => chrome.storage.session.set({ status: { connected: authenticated.size, mismatched: mismatched.size, message } });

// The token stays until the extension is removed or the popup creates a new one.
chrome.storage.local.get('token').then(({ token }) => token || chrome.storage.local.set({ token: crypto.randomUUID() }));

// HMAC-SHA256 in hex of the parts, with the token as key. The server computes the same.
const encoder = new TextEncoder();
const hmac = async (token, ...parts) => {
  const key = await crypto.subtle.importKey('raw', encoder.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(parts.join(':')));
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, '0')).join('');
};

// Checks the proof of the server and answers with the proof of the extension. Returns false if the server does not have the token.
const prove = async (socket, nonce, data) => {
  const { nonce: serverNonce, proof } = JSON.parse(data);
  const { token } = await chrome.storage.local.get('token');
  // Each connection has new nonces, so the time that the comparison takes tells nothing.
  if (proof !== await hmac(token, 'server', nonce, serverNonce))
    return false;
  socket.send(JSON.stringify({ proof: await hmac(token, 'extension', nonce, serverNonce) }));
  return true;
};

// Each response goes back on the connection of its request.
const handle = async (socket, { id, method, params }) => {
  try {
    if (!Object.hasOwn(methods, method))
      throw new Error(`Unknown method ${method}.`);
    socket.send(JSON.stringify({ id, result: await methods[method](params) }));
  } catch (error) {
    socket.send(JSON.stringify({ id, error: error.message }));
  }
};

// The extension sends a nonce, the server proves that it has the token, and then the extension proves it.
// The token never goes over the connection, and a server that cannot prove it gets no answers.
const open = port => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const nonce = crypto.randomUUID();
  let keepalive, refused = false;
  sockets.set(port, socket);

  socket.onopen = () => socket.send(JSON.stringify({ nonce }));
  socket.onmessage = async ({ data }) => {
    if (authenticated.has(socket))
      return handle(socket, JSON.parse(data));
    if (!await prove(socket, nonce, data).catch(() => false)) {
      refused = true;
      return socket.close();
    }
    authenticated.add(socket);
    // Messages within 30 seconds keep the service worker alive.
    keepalive = setInterval(() => socket.send('{}'), 20_000);
    message = undefined;
    setStatus();
  };
  socket.onclose = ({ code, reason }) => {
    clearInterval(keepalive);
    authenticated.delete(socket);
    if (sockets.get(port) === socket)
      sockets.delete(port);
    mismatched[refused ? 'add' : 'delete'](port);
    if (code === 4000)
      message = reason;
    setStatus();
  };
};

// Connects to all MCP servers that run. Ports without a server fail fast.
const connect = async () => {
  const { enabled, firstPort } = await chrome.storage.local.get({ enabled: true, firstPort: FIRST_PORT });
  if (!enabled)
    return;
  for (let port = firstPort; port < firstPort + PORT_COUNT; port++) {
    if (!sockets.has(port))
      open(port);
  }
};

const disconnect = () => {
  for (const socket of sockets.values())
    socket.close();
  sockets.clear();
  mismatched.clear();
  message = undefined;
  setStatus();
};

setStatus();
connect();

// A connection keeps the service worker alive. Without one, the alarm wakes it to look for new servers.
chrome.alarms.get('connect').then(alarm => alarm ?? chrome.alarms.create('connect', { periodInMinutes: 0.5 }));
chrome.alarms.onAlarm.addListener(connect);

// The popup asks for a connection when it opens.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request === 'connect') {
    connect();
    sendResponse();
  }
});

// A new token closes the connections of the old one.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.enabled || changes.firstPort || changes.token)) {
    disconnect();
    connect();
  }
});
