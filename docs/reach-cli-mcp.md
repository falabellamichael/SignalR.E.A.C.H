# MCP tools in REACH CLI

REACH CLI uses the running REACH Studio application's authenticated loopback
bridge and existing MCP server manager. It does not copy credentials or launch
a separate Roblox server. Both CLI and Studio must include this implementation.

## Setup

1. Run an updated Studio build from this repository and enable your servers in
   Settings > MCP. Existing Roblox and Blender configurations are reused.
2. Start a fresh CLI from this checkout with `python tools/reach-cli.py`.
3. Use `/settings studio mcp` to inspect servers and
   `/settings studio mcp test Roblox_Studio` to test the saved Roblox server.
4. Ask the agent to discover the `mcp` category. It exposes `mcp_discover` and
   `mcp_call`. Discover remote schemas before calling a tool.

For example, discover with `{"action":"mcp_discover","query":"roblox"}`,
then call `{"action":"mcp_call","name":"roblox-studio__list_roblox_studios","arguments":{}}`.
Choose the intended Studio instance before modifying a game.

## Permissions and limitations

- Remote discovery can start enabled third-party servers and requires approval.
- Every remote call requires approval, even when a server claims it is read-only.
  Existing CLI auto-approval settings still apply.
- MCP descriptions and results are untrusted data, not assistant instructions.
- Text results use the existing CLI output limits. Image blocks are not rendered
  by this text bridge.
- Restart an updated Studio if bridge calls fail or report an unsupported method.
- The CLI reads `~/.config/reach-cli/studio-bridge.json`. Run CLI and Studio under
  the same OS user. A WSL CLI cannot automatically use a Windows Studio bridge;
  use the native Windows Python CLI for Windows Studio. Do not expose the bridge
  to the network or copy its token into commands.
- Updating source does not update an installed packaged CLI or Studio. Rebuild
  or run both applications from this checkout to activate the feature.
