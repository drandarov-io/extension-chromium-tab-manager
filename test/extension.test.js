import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright-core';

const extensionPath = fileURLToPath(new URL('../extension', import.meta.url));
const serverPath = fileURLToPath(new URL('../server/server.js', import.meta.url));

let context, worker, extensionId, web, firstPort;

// Runs a function with the chrome APIs of the extension.
const inExtension = (fn, arg) => worker.evaluate(fn, arg);

before(async () => {
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).host;

  // Pages whose title is their path.
  web = createHttpServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(`<title>${req.url.slice(1)}</title>`)).listen(0, '127.0.0.1');
  await once(web, 'listening');

  // A free range of ports, so that the test does not meet a real MCP server.
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  firstPort = probe.address().port;
  probe.close();
});

after(async () => {
  await context.close();
  web.close();
});

// Starts a server as an MCP client does, and lets the extension connect to it now.
const startServer = async (t, env = {}) => {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, TAB_MANAGER_EXTENSION_IDS: extensionId, TAB_MANAGER_PORT: String(firstPort), TAB_MANAGER_CONNECT_TIMEOUT_MS: '5000', ...env },
    stderr: 'ignore',
  }));
  t.after(() => client.close());
  // A changed setting makes the extension connect now, instead of at its next alarm.
  await inExtension(async port => {
    await chrome.storage.local.set({ enabled: false });
    await chrome.storage.local.set({ firstPort: port, enabled: true });
  }, firstPort);

  const call = async (name, args = {}) => {
    const { isError, content } = await client.callTool({ name, arguments: args });
    if (isError)
      throw new Error(content[0].text);
    return JSON.parse(content[0].text);
  };
  return { client, call };
};

// Opens tabs in a new window, waits until they load, and returns their IDs.
const openTabs = (...names) => inExtension(async urls => {
  const { id: windowId } = await chrome.windows.create({ url: urls });
  let tabs;
  while ((tabs = await chrome.tabs.query({ windowId })).some(tab => tab.status !== 'complete'))
    await new Promise(resolve => setTimeout(resolve, 50));
  return tabs.map(tab => tab.id);
}, names.map(name => `http://127.0.0.1:${web.address().port}/${name}`));

const userGroups = () => inExtension(async () => {
  const groups = await chrome.tabGroups.query({});
  return Promise.all(groups.map(async ({ id, title, color }) =>
    ({ id, title, color, tabIds: (await chrome.tabs.query({ groupId: id })).map(tab => tab.id) })));
});

test('reads tabs and changes tab groups, and keeps groups that it does not change', async t => {
  const { call } = await startServer(t);
  const [one, two, three, four] = await openTabs('one', 'two', 'three', 'four');
  const klipper = await inExtension(async tabIds => {
    const groupId = await chrome.tabs.group({ tabIds });
    await chrome.tabGroups.update(groupId, { title: 'Klipper', color: 'green' });
    return groupId;
  }, [one, two]);

  const listed = (await call('list_tab_groups')).find(group => group.id === klipper);
  assert.deepEqual({ ...listed, tabs: listed.tabs.map(tab => tab.id) }, { id: klipper, windowId: listed.windowId, title: 'Klipper', color: 'green', collapsed: false, tabs: [one, two] });
  assert.deepEqual((await call('list_tabs', { text: 'THREE' })).map(tab => tab.id), [three]);
  assert.deepEqual((await call('list_tabs', { groupId: klipper })).map(tab => tab.id), [one, two]);

  const created = await call('create_tab_group', { tabIds: [three], title: 'New', color: 'blue' });
  assert.deepEqual([created.title, created.color, created.tabs.map(tab => tab.id)], ['New', 'blue', [three]]);

  const renamed = await call('update_tab_group', { groupId: klipper, title: 'Klipper 2' });
  assert.deepEqual([renamed.title, renamed.color], ['Klipper 2', 'green']);

  assert.deepEqual((await call('add_tabs_to_group', { groupId: klipper, tabIds: [four] })).tabs.map(tab => tab.id), [one, two, four]);
  assert.deepEqual((await call('add_tabs_to_group', { groupId: created.id, tabIds: [two] })).tabs.map(tab => tab.id).sort(), [two, three].sort());
  assert.deepEqual((await call('ungroup_tabs', { tabIds: [four] })).map(tab => tab.groupId), [-1]);

  // Ungrouping the last tabs removes the group, and its ID becomes stale.
  await call('ungroup_tabs', { tabIds: [two, three] });
  await assert.rejects(call('update_tab_group', { groupId: created.id, title: 'Gone' }), /No group with id/);
  await assert.rejects(call('ungroup_tabs', { tabIds: [999_999] }), /No tab with id/);
  await assert.rejects(call('update_tab_group', { groupId: klipper }), /Pass at least one/);

  const [other] = await openTabs('other');
  await assert.rejects(call('create_tab_group', { tabIds: [one, other] }), /different windows/);
  await assert.rejects(call('add_tabs_to_group', { groupId: klipper, tabIds: [other] }), /do not move between windows/);
  assert.deepEqual((await userGroups()).find(group => group.id === klipper), { id: klipper, title: 'Klipper 2', color: 'green', tabIds: [one] });
});

test('keeps user groups when the MCP client stops', async t => {
  const [one] = await openTabs('kept');
  const groupId = await inExtension(async tabIds => {
    const groupId = await chrome.tabs.group({ tabIds });
    await chrome.tabGroups.update(groupId, { title: 'Kept', color: 'red' });
    return groupId;
  }, [one]);
  const before = await userGroups();

  const { client, call } = await startServer(t);
  await call('list_tab_groups');
  await client.close();

  assert.deepEqual(await userGroups(), before);
  assert.ok(before.some(group => group.id === groupId));
});

test('serves two MCP servers, and the switch disconnects them', async t => {
  const first = await startServer(t);
  const second = await startServer(t);
  while (await inExtension(async () => (await chrome.storage.session.get('status')).status.connected) !== 2)
    await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok((await first.call('list_tabs')).length);
  assert.ok((await second.call('list_tabs')).length);

  await inExtension(() => chrome.storage.local.set({ enabled: false }));
  await assert.rejects(first.call('list_tabs'), /No browser is connected/);
  assert.equal((await inExtension(() => chrome.storage.session.get('status'))).status.connected, 0);

  await inExtension(() => chrome.storage.local.set({ enabled: true }));
  assert.ok((await first.call('list_tabs')).length);
});

test('the popup shows the status and copies group links and the MCP config', async t => {
  await startServer(t);
  const [one, two] = await openTabs('alpha', 'beta');
  await inExtension(async tabIds => {
    const groupId = await chrome.tabs.group({ tabIds });
    await chrome.tabGroups.update(groupId, { title: 'Copy me' });
  }, [one, two]);

  const page = await context.newPage();
  t.after(() => page.close());
  // The test cannot read the system clipboard in every environment, so it records what the popup writes.
  await page.addInitScript(() => navigator.clipboard.writeText = async text => window.copied = text);
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  await page.getByText('Connected to 1 MCP server.').waitFor();
  const row = page.locator('.group', { hasText: 'Copy me' });
  await row.getByRole('button', { name: 'Copy URLs' }).click();
  assert.equal(await page.evaluate(() => window.copied), `http://127.0.0.1:${web.address().port}/alpha\r\nhttp://127.0.0.1:${web.address().port}/beta`);
  await row.getByRole('button', { name: 'Copy Markdown' }).click();
  assert.equal(await page.evaluate(() => window.copied), `- [alpha](http://127.0.0.1:${web.address().port}/alpha)\r\n- [beta](http://127.0.0.1:${web.address().port}/beta)`);

  await page.getByRole('button', { name: 'Copy MCP server config' }).click();
  assert.deepEqual(JSON.parse(`{${await page.evaluate(() => window.copied)}}`), {
    'tab-manager': { command: 'npx', args: ['-y', 'chromium-tab-manager-mcp'], env: { TAB_MANAGER_EXTENSION_IDS: extensionId } },
  });

  await page.getByLabel('Let AI agents read tabs').uncheck();
  await page.getByText('Off. AI agents cannot read tabs').waitFor();
});
