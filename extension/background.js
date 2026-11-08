import { addToGroup, createGroup, listGroups, listTabs, ungroup, updateGroup } from './tabs.js';

// The MCP server listens on the first free port of this range. The storage can change the first port for tests.
const FIRST_PORT = 17890;
const PORT_COUNT = 10;

const methods = {
  list_tabs: listTabs,
  list_tab_groups: ({ windowId }) => listGroups(windowId),
  create_tab_group: createGroup,
  update_tab_group: updateGroup,
  add_tabs_to_group: addToGroup,
  ungroup_tabs: ungroup,
};

// Open and opening connections by port.
const sockets = new Map();
let message;

// The popup shows the status.
const setStatus = () => chrome.storage.session.set({
  status: { connected: [...sockets.values()].filter(socket => socket.readyState === WebSocket.OPEN).length, message },
});

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

const open = port => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  let keepalive;
  sockets.set(port, socket);

  socket.onopen = () => {
    // Messages within 30 seconds keep the service worker alive.
    keepalive = setInterval(() => socket.send('{}'), 20_000);
    message = undefined;
    setStatus();
  };
  socket.onmessage = ({ data }) => handle(socket, JSON.parse(data));
  socket.onclose = ({ code, reason }) => {
    clearInterval(keepalive);
    if (sockets.get(port) === socket)
      sockets.delete(port);
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

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.enabled || changes.firstPort)) {
    disconnect();
    connect();
  }
});
