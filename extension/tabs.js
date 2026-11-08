// Tab and tab group functions. The service worker answers MCP requests with them, and the popup lists groups with them.

const toTab = ({ id, windowId, index, groupId, title, url, pendingUrl, active, pinned, audible, discarded }) =>
  ({ id, windowId, index, groupId, title, url: url || pendingUrl, active, pinned, audible, discarded });

const toGroup = ({ id, windowId, title, color, collapsed }, tabs) => ({ id, windowId, title, color, collapsed, tabs });

// Chrome rejects with "No tab with id" for a stale ID, so no change starts with an unknown tab.
const getTabs = tabIds => Promise.all(tabIds.map(id => chrome.tabs.get(id)));

export const listTabs = async ({ windowId, groupId, text } = {}) => {
  const needle = text?.toLowerCase();
  return (await chrome.tabs.query({ windowId, groupId }))
    .map(toTab)
    .filter(tab => !needle || [tab.title, tab.url].some(value => value?.toLowerCase().includes(needle)));
};

export const listGroups = async windowId => {
  const [groups, tabs] = await Promise.all([chrome.tabGroups.query({ windowId }), listTabs({ windowId })]);
  const tabsByGroup = Object.groupBy(tabs, tab => tab.groupId);
  return groups.map(group => toGroup(group, tabsByGroup[group.id] ?? []));
};

const getGroup = async groupId => toGroup(await chrome.tabGroups.get(groupId), await listTabs({ groupId }));

export const createGroup = async ({ tabIds, title, color, collapsed }) => {
  const tabs = await getTabs(tabIds);
  const { windowId } = tabs[0];
  if (tabs.some(tab => tab.windowId !== windowId))
    throw new Error('The tabs are in different windows. Create one group per window.');

  // Without the window, Chrome moves the tabs to the current window.
  const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
  try {
    await chrome.tabGroups.update(groupId, { title, color, collapsed });
  } catch (error) {
    throw new Error(`Group ${groupId} was created, but its title, color or collapsed state was not set: ${error.message}`);
  }
  return getGroup(groupId);
};

export const updateGroup = async ({ groupId, title, color, collapsed }) => {
  if (title === undefined && color === undefined && collapsed === undefined)
    throw new Error('Pass at least one of title, color and collapsed.');
  await chrome.tabGroups.update(groupId, { title, color, collapsed });
  return getGroup(groupId);
};

export const addToGroup = async ({ groupId, tabIds }) => {
  const [group, tabs] = await Promise.all([chrome.tabGroups.get(groupId), getTabs(tabIds)]);
  const other = tabs.find(tab => tab.windowId !== group.windowId);
  if (other)
    throw new Error(`Tab ${other.id} is in window ${other.windowId}, but group ${groupId} is in window ${group.windowId}. Tabs do not move between windows.`);

  await chrome.tabs.group({ groupId, tabIds });
  return getGroup(groupId);
};

export const ungroup = async ({ tabIds }) => {
  await getTabs(tabIds);
  await chrome.tabs.ungroup(tabIds);
  return (await getTabs(tabIds)).map(toTab);
};
