import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import pkg from '../package.json' with { type: 'json' };

const id = z.number().int();
const tabIds = z.array(id).min(1).describe('IDs of tabs, from list_tabs or list_group_tabs.');
const groupId = id.describe('ID of a tab group, from list_tab_groups.');
const groupFields = {
  title: z.string().optional().describe('Name of the group.'),
  color: z.enum(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']).optional(),
  collapsed: z.boolean().optional(),
};

const reads = { readOnlyHint: true, openWorldHint: false };
const writes = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

const tools = {
  list_tabs: {
    description: 'List open tabs in all windows with ID, window, position, group, title and URL. A groupId of -1 means that the tab is in no group. Page content is not included. The filters combine.',
    inputSchema: {
      windowId: id.optional().describe('Only tabs in this window.'),
      groupId: id.optional().describe('Only tabs in this group. Use -1 for tabs that are in no group.'),
      text: z.string().optional().describe('Only tabs whose title or URL contains this text. Case is ignored.'),
    },
    annotations: reads,
  },
  list_tab_groups: {
    description: 'List tab groups with ID, window, title, color, collapsed state and number of tabs. Use list_group_tabs for the tabs of a group.',
    inputSchema: { windowId: id.optional().describe('Only groups in this window.') },
    annotations: reads,
  },
  list_group_tabs: {
    description: 'List the tabs of a tab group in their order, with ID, window, position, title and URL. Page content is not included.',
    inputSchema: { groupId },
    annotations: reads,
  },
  create_tab_group: {
    description: 'Create a tab group from tabs. All tabs must be in the same window. A tab that is in another group leaves that group, and a group that loses its last tab disappears.',
    inputSchema: { tabIds, ...groupFields },
    annotations: writes,
  },
  update_tab_group: {
    description: 'Change the title, color or collapsed state of a tab group. Fields that you do not pass stay as they are.',
    inputSchema: { groupId, ...groupFields },
    annotations: writes,
  },
  add_tabs_to_group: {
    description: 'Add tabs to an existing tab group. A tab that is in another group moves to this group. The tabs must be in the same window as the group.',
    inputSchema: { groupId, tabIds },
    annotations: writes,
  },
  ungroup_tabs: {
    description: 'Remove tabs from their tab groups. A group that loses its last tab disappears. The tabs stay open.',
    inputSchema: { tabIds },
    annotations: { ...writes, destructiveHint: true },
  },
};

const instructions = 'Tab Manager MCP reads the title and URL of open browser tabs and manages tab groups through a browser extension. Tab, group and window IDs are valid only until the browser restarts. Call list_tab_groups, list_group_tabs or list_tabs before you make a change, and use the IDs that they return.';

// call(method, params) runs the method in the browser extension and resolves with its result.
export const createMcpServer = call => {
  const server = new McpServer({ name: 'tab-manager', version: pkg.version }, { instructions });
  for (const [name, config] of Object.entries(tools))
    server.registerTool(name, config, async params => ({ content: [{ type: 'text', text: JSON.stringify(await call(name, params)) }] }));
  return server;
};
