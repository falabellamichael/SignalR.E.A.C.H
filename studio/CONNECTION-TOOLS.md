# Connection tool coverage

The connection cards and companion now derive their actions from the registered
plugin tools. Every new operation has an argument schema, fixed provider route,
and an approval requirement for writes. Existing disabled-tool controls apply.
This is not exhaustive coverage of every provider API.

Expanded operations:

| Connection | Added capabilities |
| --- | --- |
| Gmail | Individual messages, threads, labels, drafts, draft creation/deletion, label changes, trash/restore |
| Outlook | Individual messages, folders, draft creation, read/category/flag updates, move/delete |
| GitHub | Individual issues, issue creation/updates, comments, branches, releases, workflow runs |
| Google Calendar | Calendar discovery, individual events, event create/update/delete |
| Google Drive | Paginated file listing, metadata updates/trash, folders, copies, comments |
| Slack | Channels, history, threads, users, message send/update/delete |
| Notion | Pages, database schemas/query, page creation/updates, block append/archive |
| Discord | Channel metadata, individual messages, send/update/delete for direct bot-token connections |
| Microsoft To Do | Individual tasks, notes/dates/reminders/recurrence, list rename/delete, task delete, checklist CRUD, linked resources |
| Weather | Existing saved-city current conditions; no invented account or forecast API |

Use `tool_help` for operation names, selectors and allowed body fields.
Full app-tool help is loaded on demand by exact tool name to keep the expanded
catalog from exhausting small model contexts. Core To Do selector examples stay
in the JSON prompt; native tool schemas retain their full descriptions.

Bodies
use documented provider JSON shapes. Unknown top-level fields are rejected;
provider APIs validate nested shapes. Results retain pagination metadata; a page
is not a complete collection. Newly added operations do not automatically follow
pagination links. Existing `todo.read` retains its validated continuation flow.

## Permission and implementation boundaries

- Existing Google sign-in grants are read-only for Calendar/Drive and may be
  read-only for Gmail. Writes require an appropriate OAuth grant/token; adding a
  tool does not grant that permission. Consent UI upgrades are still needed.
- Outlook drafts/moves/updates need Mail.ReadWrite, separate from Mail.Send.
- Slack sign-in currently requests search:read. Channel/user/history and write
  operations need their corresponding Slack scopes and may need a new token.
- Notion operations use the existing 2022-06-28 API version and only pages shared
  with the integration. Newer data-source APIs are not included.
- Hosted Discord sign-in remains channel-read/managed-chat only. Expanded direct
  bot operations are not exposed to the companion without a saved bot token.
  Discord sends disable automatic mentions.
- To Do attachment uploads, task moves, and delta sync are not implemented.
- Mail attachment transfer, calendar free/busy, Drive binary uploads/downloads,
  GitHub repository administration, Slack administration and Discord moderation
  are not implemented by this expansion.

Verification uses controlled provider responses, not live writes to user accounts.
Do not claim provider-wide coverage or live authorization from a passing mock test.
