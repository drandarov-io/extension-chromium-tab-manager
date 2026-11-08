import { listGroups } from './tabs.js';

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

// MCP section. The service worker writes the status, and the popup writes the switch.
const showStatus = async () => {
  const [{ enabled }, { status = {} }] = await Promise.all([chrome.storage.local.get({ enabled: true }), chrome.storage.session.get('status')]);
  $('enabled').checked = enabled;
  $('status').textContent = [
    !enabled ? 'Off. AI agents cannot read tabs or change tab groups.'
      : status.connected ? `Connected to ${status.connected} MCP server${status.connected > 1 ? 's' : ''}.`
      : 'No MCP server found. Add the MCP server config to your MCP client and start the server.',
    enabled && status.message,
  ].filter(Boolean).join(' ');
};

await showStatus();
chrome.runtime.sendMessage('connect');

chrome.storage.onChanged.addListener(changes => {
  if (changes.enabled || changes.status)
    showStatus();
});

$('enabled').onchange = event => chrome.storage.local.set({ enabled: event.target.checked });

// The server accepts only the store IDs. An unpacked copy has another ID, which the config must add.
$('copy-config').onclick = async event => {
  const { installType } = await chrome.management.getSelf();
  const env = installType === 'development' ? { env: { TAB_MANAGER_EXTENSION_IDS: chrome.runtime.id } } : {};
  copy(event.target, `"tab-manager": ${JSON.stringify({ command: 'npx', args: ['-y', 'chromium-tab-manager-mcp'], ...env }, null, 2)}`);
};

// Tab group section.
const groups = await listGroups();

if (groups.length) {
  $('groups').replaceChildren(...groups.map(group => {
    const row = document.createElement('div');
    row.className = 'group';
    row.style.borderLeft = `8px solid ${COLORS[group.color] ?? '#888'}`;

    const name = document.createElement('span');
    name.className = 'group-name';
    name.textContent = group.title || '(No Name)';

    row.append(
      name,
      createButton('Copy URLs', button => copy(button, group.tabs.map(tab => tab.url).join('\r\n'))),
      createButton('Copy Markdown', button => copy(button, group.tabs.map(tab => `- [${tab.title}](${tab.url})`).join('\r\n'))),
    );
    return row;
  }));
} else {
  $('groups').textContent = 'No tab groups found.';
}
