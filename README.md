# Tab Manager MCP

Tab Manager MCP lets AI agents read the titles and URLs of your browser tabs and manage tab groups in Chrome and Microsoft Edge. It has two parts:

- The browser extension "Tab Manager MCP" in the [extension](extension) folder. Its popup also copies the links of a tab group as a list of URLs or as Markdown.
- The MCP server, the npm package `chromium-tab-manager-mcp` in the [server](server) folder. Your MCP client starts it.

## Setup

You need Chrome or Edge 123 or later, and Node.js 22.18 or later.

1. Install the extension from the Chrome Web Store or from Microsoft Edge Add-ons.
2. Add the MCP server to your MCP client. The button "Copy MCP server config" in the extension popup copies this entry with the token of your browser profile:

   ```json
   "tab-manager": {
     "command": "npx",
     "args": ["-y", "chromium-tab-manager-mcp"],
     "env": {
       "TAB_MANAGER_TOKEN": "<token from the popup>"
     }
   }
   ```

   In VS Code, the entry goes into `servers` in `mcp.json`. In Claude Desktop, it goes into `mcpServers`.
3. Start the MCP server in your MCP client. The popup shows "Connected to 1 MCP server."

## Connection

The MCP client starts the server. The server listens on the first free port from 17890 to 17899 on 127.0.0.1. The extension connects to each port in this range where a server runs. It looks for servers when the browser starts, when you open the popup, and every 30 seconds.

### Token

The extension creates a random token when it starts for the first time, and keeps it in its storage. The token stays the same when the browser restarts or the extension updates. It changes only when you remove the extension, or when you click "New token" in the popup. Each browser profile has its own token.

The token never goes over the connection. Each side proves that it has the token with HMAC-SHA256 over two random nonces:

1. The extension sends a nonce.
2. The server answers with its own nonce and its proof. The extension checks the proof, and closes the connection if it does not match.
3. The extension sends its proof. The server checks it, and closes the connection with code 4001 if it does not match.

The extension answers requests only after step 2, so a server without the token gets no data.

| Case | Result |
|------|--------|
| Several MCP clients run at the same time | Each server takes the next free port. The extension connects to all of them. |
| The server has another token, for example after "New token" or from another browser profile | The extension closes the connection. The popup shows "Found 1 MCP server with another token." Copy the MCP server config again and restart the server. |
| `TAB_MANAGER_TOKEN` is not set | The server does not listen, and each tool returns an error. |
| A second browser with the same token connects to the same server | The server refuses it and keeps the first browser. The popup of the second browser shows the reason. |
| No browser connects within 40 seconds of a tool call | The tool returns an error. |
| The browser does not answer within 30 seconds | The tool returns an error. |
| All 10 ports are in use | Each tool returns an error that names the ports. |

## Tools

| Tool | Changes the browser | Description |
|------|---------------------|-------------|
| `list_tabs` | No | Lists open tabs with ID, window, position, group, title and URL. Filters: window, group, text in title or URL. |
| `list_tab_groups` | No | Lists tab groups with ID, window, title, color, collapsed state and number of tabs. |
| `list_group_tabs` | No | Lists the tabs of one group with ID, window, position, title and URL. |
| `create_tab_group` | Yes | Makes a group from tabs in one window, with an optional title, color and collapsed state. |
| `update_tab_group` | Yes | Changes the title, color or collapsed state of a group. Fields that you do not set stay as they are. |
| `add_tabs_to_group` | Yes | Adds tabs to a group in the same window. A tab in another group moves to this group. |
| `ungroup_tabs` | Yes | Removes tabs from their groups. The tabs stay open. |

Tab, group and window IDs are valid until the browser restarts. A group that loses its last tab is deleted by the browser. The tools do not close tabs, read page content, change the tab order or move tabs between windows. A call with a stale ID or a tab in another window fails with an error and changes nothing.

## Privacy policy

The extension and the server send no data to the developer or to other services, and they contain no analytics.

| Subject | Policy |
|---------|--------|
| Data that the extension reads | Of each tab: ID, window, position, group, title, URL, and the active, pinned, audible and discarded state. Of each tab group: ID, window, title, color and collapsed state. The extension does not read page content, cookies, passwords or history. |
| Tabs in scope | All tabs in all windows of the browser profile. Incognito tabs only if you allow the extension in incognito windows. |
| Where the data goes | Only to the MCP server on 127.0.0.1 on your computer. The server gives it to the MCP client that started it. Your MCP client can send it to an AI model service, and the policy of that service applies. |
| Data that the extension stores | The position of the switch, the token, and the connection status, in browser storage. |
| Switch off | The switch "Let AI agents read tabs and manage tab groups" in the popup closes all connections at once. While it is off, the extension connects to nothing. |
| Who can connect | The server accepts connections only from browser extensions, and only after they prove the token. Web pages cannot connect, because the browser sets the `Origin` header of each connection. The extension answers only servers that prove the token. |

Limitation: the connection is not encrypted. A program on your computer that listens on a port from 17890 to 17899 while your MCP server runs on another port in that range can pass the handshake messages between the extension and your server, and then send its own requests to the extension. On a computer that other users use at the same time, turn the switch off when you do not use it.

## Development

```powershell
npm install
npx playwright-core install chromium
npm test
```

`npm test` runs the server tests with a simulated extension, and the browser tests, which load the extension into Playwright Chromium.

To use an unpacked copy, open `chrome://extensions` or `edge://extensions`, turn on developer mode, and load the [extension](extension) folder. An unpacked copy has its own token. Copy the MCP server config from its popup.

| Environment variable | Default | Purpose |
|----------------------|---------|---------|
| `TAB_MANAGER_TOKEN` | none, required | The token of the browser profile, from the button "Copy MCP server config" in the popup. |
| `TAB_MANAGER_PORT` | `17890` | First port of the range of 10 ports. The extension uses 17890 unless a test changes `firstPort` in its storage. |
| `TAB_MANAGER_CONNECT_TIMEOUT_MS` | `40000` | Time that a tool call waits for a browser to connect. |
| `TAB_MANAGER_CALL_TIMEOUT_MS` | `30000` | Time that a tool call waits for the answer of the browser. |

The icon source is [store/icon.svg](store/icon.svg). The 128-pixel icon has 16 pixels of transparent space on each side, as the [Chrome Web Store image guidelines](https://developer.chrome.com/docs/webstore/images#icons) require.

## Publishing

1. Make the extension package:

   ```powershell
   Compress-Archive -Path extension\* -DestinationPath tab-manager-mcp-extension.zip
   ```

2. Run `npm test`, then `npm login` and `npm publish`.
3. Upload the package in the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole) and in [Microsoft Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/overview).
4. Fill in the store listings with the text below, and submit the extension for review in both stores.
5. Add the store links to the setup section of this README.

### Store listing

| Field | Text |
|-------|------|
| Name | Tab Manager MCP |
| Summary | Lets AI agents read the titles and URLs of your tabs and manage tab groups through MCP. Copies the links of a tab group. |
| Single purpose | Give AI agents on this computer access to the open tabs and tab groups of the browser, through a local MCP server, so that they can read and organize them. |
| `tabs` permission | Reads the title and URL of open tabs for the AI agent and for the copy buttons. |
| `tabGroups` permission | Reads, creates and changes tab groups for the AI agent and lists them in the popup. |
| `storage` permission | Stores the position of the switch, the token for the local MCP server, and the connection status. |
| `alarms` permission | Looks for new local MCP servers every 30 seconds. |
| `clipboardWrite` permission | Copies the links of a tab group and the MCP server config to the clipboard when you click a button. |
| Remote code | No. All code is in the package. |
| Data use | Website titles and URLs of open tabs. The data goes only to the local MCP server. It is not sold and not used for other purposes. The store documentation does not list the data categories; "Web history" is the expected category, but this is not confirmed. |
| Privacy policy URL | https://github.com/drandarov-io/extension-chromium-tab-manager#privacy-policy |

The Chrome Web Store also needs at least one screenshot of 1280 x 800 or 640 x 400 pixels.
