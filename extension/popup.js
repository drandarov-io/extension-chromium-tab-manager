import { listGroups, listTabs } from './tabs.js';

// Chromium tab group colors
const COLORS = {
  grey: '#9AA0A6',
  blue: '#4285F4',
  red: '#EA4335',
  yellow: '#FBBC05',
  green: '#34A853',
  pink: '#FF80AB',
  purple: '#A142F4',
  cyan: '#00BCD4',
  orange: '#FF8C00',
};

const $ = id => document.getElementById(id);

// Shows a message on a button for a moment.
const flash = (button, text) => {
  const label = button.textContent;
  button.textContent = text;
  setTimeout(() => button.textContent = label, 1200);
};

const copy = (button, text) =>
  navigator.clipboard.writeText(text).then(() => flash(button, 'Copied!'), () => flash(button, 'Copy failed'));

const createButton = (label, onclick) =>
  Object.assign(document.createElement('button'), { textContent: label, onclick: event => onclick(event.target) });

// MCP section. The service worker writes the status and the first token, and the popup writes the switch and new tokens.
const servers = count => `${count} MCP server${count > 1 ? 's' : ''}`;

const showStatus = async () => {
  const [{ enabled }, { status = {} }] = await Promise.all([chrome.storage.local.get({ enabled: true }), chrome.storage.session.get('status')]);
  $('enabled').checked = enabled;
  $('status').dataset.state = !enabled ? 'off' : status.connected ? 'connected' : 'waiting';
  $('status').textContent = !enabled ? 'Off. AI agents cannot read tabs or change tab groups.' : [
    status.connected ? `Connected to ${servers(status.connected)}.`
      : !status.mismatched && 'No MCP server found. Add the MCP server config to your MCP client and start the server.',
    status.mismatched && `Found ${servers(status.mismatched)} with another token. Copy the MCP server config again and restart the server.`,
    status.message,
  ].filter(Boolean).join(' ');
};

await showStatus();
chrome.runtime.sendMessage('connect');

chrome.storage.onChanged.addListener(changes => {
  if (changes.enabled || changes.status)
    showStatus();
});

$('enabled').onchange = event => chrome.storage.local.set({ enabled: event.target.checked });

$('copy-config').onclick = async event => {
  const { token } = await chrome.storage.local.get('token');
  copy(event.target, `"tab-manager": ${JSON.stringify({ command: 'npx', args: ['-y', 'chromium-tab-manager-mcp'], env: { TAB_MANAGER_TOKEN: token } }, null, 2)}`);
};

// The service worker closes the connections of the old token. MCP servers with the old token stop working.
$('new-token').onclick = async event => {
  await chrome.storage.local.set({ token: crypto.randomUUID() });
  flash(event.target, 'Copy the config again');
};

// Tab group section. The copy buttons read the tabs when they are clicked.
const groups = await listGroups();

if (groups.length) {
  $('groups').replaceChildren(...groups.map(group => {
    const row = Object.assign(document.createElement('div'), { className: 'group' });
    row.style.setProperty('--color', COLORS[group.color] ?? '#888');
    const copyTabs = format => async button => copy(button, (await listTabs({ groupId: group.id })).map(format).join('\r\n'));

    row.append(
      Object.assign(document.createElement('span'), { className: 'name', textContent: group.title || '(No Name)', title: group.title }),
      Object.assign(document.createElement('span'), { className: 'count', textContent: group.tabCount, title: `${group.tabCount} tabs` }),
      createButton('Copy URLs', copyTabs(tab => tab.url)),
      createButton('Copy Markdown', copyTabs(tab => `- [${tab.title}](${tab.url})`)),
    );
    return row;
  }));
} else {
  $('groups').textContent = 'No tab groups found.';
}
