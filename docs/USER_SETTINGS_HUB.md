# User settings hub

The public hub targets REACH Studio and the SimpleREACH VS Code extension.
The SimpleRAG extension keeps its Dashboard, Endpoint, Models, Playground, Usage,
Logs, Settings, and About pages. Its **Shared settings** page opens the same local
hub, and the second panel provides the **Sync Studio + VS Code** switch.
The hub settings are independent of the SimpleRAG connection selected in the
extension's Settings page.

Start an updated Studio or activate the updated VS Code extension, then visit
`http://127.0.0.1:21309/`. VS Code also provides **REACH: Shared Settings Hub**.
Save a connection name, endpoint URL, model, temperature and output-token limit.
Enable **Sync Studio + VS Code** in the public extension's second panel or in
the standalone hub. Sync defaults to off. While enabled, both running clients
check for new revisions every second and refresh their settings automatically,
without restarting windows or interrupting active work. Turning it off preserves
the last applied client settings. Clients that are closed apply changes next time
they start with sync enabled. Existing
conversation-specific model overrides remain in effect. VS Code workspace-level
overrides can override user settings and must be removed if they conflict.

On Windows the shared file is `%LOCALAPPDATA%/SignalREACH/user-settings.json`.
Each new revision is imported once so later client-local edits are preserved
until the hub is saved again. This is hub-to-client synchronization; client-local
edits are not written back into the hub.

API keys remain in the clients' credential stores and are not synchronized.
Configure credentials for the same endpoint in each client when needed.
No administrator settings, tool permissions, MCP servers or shell controls are
accepted by the hub. It binds only to loopback, rejects foreign origins/hosts,
and requires a per-process token for its settings API.

Both clients must be rebuilt/reinstalled to support the new shared settings
module. Existing public extension preferences continue to configure only the
SimpleRAG extension. They are not migrated into the shared Studio/VS Code hub.
