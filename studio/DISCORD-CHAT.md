# Talk to REACH Studio through Discord

In Settings → App Connections → Discord, connect your own Discord account and
authorize the REACH Studio bot for your server. The bot installation requests
Administrator permission. Studio saves your account authorization separately
from the optional channel check and brings its window forward when sign-in ends.

Enable **Talk to REACH in Discord while Studio is open**, choose a saved project
or General conversation, and Save. The status becomes Online once Discord's
Gateway is connected. DM the REACH Studio bot, or mention it in any server text
channel that you and the bot can access. The saved channel ID is the default for
the message-reading tool; it does not restrict where you can talk to REACH.
Separate channels have separate conversations and approval codes.

Studio uses its selected model and normal agent runtime. Discord conversations
are saved in Studio history. Each linked account controls only its own Studio
instance; other server members cannot run commands in that instance. Bot and
webhook messages are ignored. Server-channel messages must mention REACH, except
for the explicit control commands below in a channel with a recent conversation
or in your saved default channel. Mention REACH with a command to start elsewhere.

- `!status`: show whether the conversation is running and its selected project.
- `!stop`: stop the conversation and clear its queued requests.
- `!new`: begin a fresh conversation after the current request has ended.
- `!approve CODE` / `!deny CODE`: answer an application's pending tool approval.
  Only the same linked account and conversation can answer that approval.

Tool approvals retain the normal Studio policy. Approval details too long for
Discord open in Studio instead. Proposed file edits retain Studio's edit review.
The bot does not automatically accept edits or override disabled tools. Ordinary
text and Markdown replies are supported; voice and attachment import are not.

The publisher bot credential stays on the REACH service. Customer OAuth grants
stay encrypted in that customer's local profile. The service receives Discord
events and temporarily queues addressed messages for the linked desktop, then
posts that desktop's replies back to the original channel. Requested content is
processed by the model selected in Studio. Pending messages are bounded and are
not replayed as new commands after an app restart.

Implementation: `agent/discord-chat.cjs` owns the Studio conversations;
`../RCH/service/discord-chat.mjs` owns Gateway heartbeat/resume and isolated
message delivery. The three explicit hosted routes are
`/oauth/discord/chat-poll`, `/oauth/discord/chat-reply` and
`/oauth/discord/chat-close`.
# Tool activity and reply delivery

Discord runs use the normal Studio agent tools and permission checks. The bridge
now reports actual tool starts and results, distinguishing success, failure, and
pending edit review. Terminal/Python, web search, browser automation, file work,
connected apps, and MCP calls are identified when those tools execute. Raw command
arguments and tool output are not copied into progress messages.

Progress is capped at 16 messages per request to leave capacity for approvals and
the final reply. `!status` includes the last eight activity events; Studio retains
the full details. `!help` explains commands and tool availability. Python requires
an installed interpreter; project file operations require a selected saved project.
Disabled tools remain disabled and edit review still happens in Studio.

A run with no new assistant answer no longer reuses an answer from a previous
request. The final response is automatically relayed; the Discord persona instructs
agents not to separately send the same response through a Discord tool.
