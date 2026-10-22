'use strict';

// Fixed provider routes, never a model-supplied URL. OAuth grants are not expanded here.
const OPERATIONS = {
  'discord.channel': ['GET', 'channels/{channel}', [], 'Read channel metadata. Requires a direct bot-token connection; hosted sign-in currently supports message reads only.'],
  'discord.message': ['GET', 'channels/{channel}/messages/{id}', [], 'Read a specific message. Requires a direct bot-token connection.'],
  'discord.send': ['POST', 'channels/{channel}/messages', ['content'], 'Send a message after approval, with mentions disabled. Requires a direct bot-token connection. Do not duplicate automatically relayed chat replies.'],
  'discord.update': ['PATCH', 'channels/{channel}/messages/{id}', ['content'], 'Edit a bot-owned message after approval, with mentions disabled. Requires a direct bot-token connection.'],
  'discord.delete': ['DELETE', 'channels/{channel}/messages/{id}', [], 'Delete a message after approval and Discord permission checks. Requires a direct bot-token connection.'],
  'gmail.get': ['GET', 'messages/{id}', [], 'Read a Gmail message by ID.'],
  'gmail.labels': ['GET', 'labels', [], 'List Gmail labels.'],
  'gmail.thread': ['GET', 'threads/{id}', [], 'Read a Gmail thread.'],
  'gmail.drafts': ['GET', 'drafts', [], 'List drafts and nextPageToken.'],
  'gmail.create_draft': ['POST', 'drafts', ['message'], 'Create a Gmail draft with message.raw as base64url MIME. Requires gmail.compose; does not send.'],
  'gmail.delete_draft': ['DELETE', 'drafts/{id}', [], 'Delete a Gmail draft after approval; does not send.'],
  'gmail.modify': ['POST', 'messages/{id}/modify', ['addLabelIds','removeLabelIds'], 'Apply/remove labels or mark read/unread using UNREAD. Requires gmail.modify.'],
  'gmail.trash': ['POST', 'messages/{id}/trash', [], 'Move mail to Trash after approval; requires gmail.modify.'],
  'gmail.untrash': ['POST', 'messages/{id}/untrash', [], 'Restore mail from Trash after approval.'],
  'outlook.get': ['GET', '/messages/{id}', [], 'Read an Outlook message.'],
  'outlook.folders': ['GET', '/mailFolders', [], 'List Outlook mail folders.'],
  'outlook.create_draft': ['POST', '/messages', ['subject','body','toRecipients','ccRecipients','bccRecipients','importance'], 'Create an Outlook draft after approval. Requires Mail.ReadWrite; does not send.'],
  'outlook.update': ['PATCH', '/messages/{id}', ['isRead','categories','flag'], 'Mark read/unread, categorize or flag mail. Requires Mail.ReadWrite.'],
  'outlook.move': ['POST', '/messages/{id}/move', ['destinationId'], 'Move mail to a returned folder ID after approval. Requires Mail.ReadWrite.'],
  'outlook.delete': ['DELETE', '/messages/{id}', [], 'Delete an Outlook message after approval. Requires Mail.ReadWrite.'],
  'github.get_issue': ['GET', '/repos/{owner}/{repo}/issues/{id}', [], 'Read an issue or PR issue record.'],
  'github.create_issue': ['POST', '/repos/{owner}/{repo}/issues', ['title','body','labels','assignees'], 'Create an issue after approval.'],
  'github.update_issue': ['PATCH', '/repos/{owner}/{repo}/issues/{id}', ['title','body','state','state_reason','labels','assignees'], 'Update or close an issue after approval.'],
  'github.comments': ['GET', '/repos/{owner}/{repo}/issues/{id}/comments', [], 'Read issue or PR discussion comments.'],
  'github.comment': ['POST', '/repos/{owner}/{repo}/issues/{id}/comments', ['body'], 'Comment on an issue or PR after approval.'],
  'github.branches': ['GET', '/repos/{owner}/{repo}/branches', [], 'List repository branches.'],
  'github.releases': ['GET', '/repos/{owner}/{repo}/releases', [], 'List repository releases.'],
  'github.workflows': ['GET', '/repos/{owner}/{repo}/actions/runs', [], 'List workflow runs.'],
  'calendar.calendars': ['GET', 'users/me/calendarList', [], 'List accessible calendars.'],
  'calendar.get': ['GET', 'calendars/{calendar}/events/{id}', [], 'Read an event by ID. Use primary for your primary calendar.'],
  'calendar.create': ['POST', 'calendars/{calendar}/events', ['summary','description','start','end','location','attendees','recurrence'], 'Create an event. Requires Calendar write permission.'],
  'calendar.update': ['PATCH', 'calendars/{calendar}/events/{id}', ['summary','description','start','end','location','attendees','recurrence','status'], 'Update only supplied event fields. Requires Calendar write permission.'],
  'calendar.delete': ['DELETE', 'calendars/{calendar}/events/{id}', [], 'Delete an event after approval.'],
  'drive.list': ['GET', 'files', [], 'List Drive files; query supports pageToken, q, pageSize and fields. Preserve nextPageToken for pagination.'],
  'drive.update': ['PATCH', 'files/{id}', ['name','description','starred','trashed'], 'Rename, describe, star or trash a Drive file; requires write permission.'],
  'drive.create_folder': ['POST', 'files', ['name','parents'], 'Create a Drive folder. Requires write permission.'],
  'drive.copy': ['POST', 'files/{id}/copy', ['name','parents'], 'Copy a Drive file after approval.'],
  'drive.comments': ['GET', 'files/{id}/comments', [], 'Read comments; supply fields and pageToken as needed.'],
  'slack.channels': ['GET', 'conversations.list', [], 'List accessible Slack channels, preserving response_metadata.next_cursor.'],
  'slack.history': ['GET', 'conversations.history', [], 'Read channel messages; query requires channel, optionally cursor and limit.'],
  'slack.thread': ['GET', 'conversations.replies', [], 'Read a thread; query requires channel and ts.'],
  'slack.send': ['POST', 'chat.postMessage', ['channel','text','thread_ts'], 'Send a Slack message after approval; requires chat:write.'],
  'slack.update': ['POST', 'chat.update', ['channel','ts','text'], 'Update a message permitted by the Slack token after approval.'],
  'slack.delete': ['POST', 'chat.delete', ['channel','ts'], 'Delete a message permitted by the Slack token after approval.'],
  'slack.users': ['GET', 'users.list', [], 'List workspace members, preserving pagination.'],
  'notion.page': ['GET', 'pages/{id}', [], 'Read a shared Notion page and its properties.'],
  'notion.database': ['GET', 'databases/{id}', [], 'Read a Notion database schema.'],
  'notion.query': ['POST', 'databases/{id}/query', ['filter','sorts','start_cursor','page_size'], 'Query a shared database. This operation is read-only.'],
  'notion.create_page': ['POST', 'pages', ['parent','properties','children','icon','cover'], 'Create a page after approval; requires insert-content permission.'],
  'notion.update_page': ['PATCH', 'pages/{id}', ['properties','archived','icon','cover'], 'Update properties or archive a page after approval.'],
  'notion.append_blocks': ['PATCH', 'blocks/{id}/children', ['children','after'], 'Append blocks after approval; requires update-content permission.'],
  'notion.delete_block': ['DELETE', 'blocks/{id}', [], 'Archive a block after approval.'],
  'todo.get': ['GET', 'me/todo/lists/{list}/tasks/{id}', [], 'Read one task with all returned details.'],
  'todo.details': ['PATCH', 'me/todo/lists/{list}/tasks/{id}', ['body','dueDateTime','startDateTime','reminderDateTime','isReminderOn','recurrence'], 'Update task notes, dates, reminders or recurrence. Use Graph dateTimeTimeZone and patternedRecurrence shapes. Requires Tasks.ReadWrite.'],
  'todo.rename_list': ['PATCH', 'me/todo/lists/{list}', ['displayName'], 'Rename a To Do list after approval.'],
  'todo.delete_list': ['DELETE', 'me/todo/lists/{list}', [], 'Delete a To Do list and its tasks after approval.'],
  'todo.delete': ['DELETE', 'me/todo/lists/{list}/tasks/{id}', [], 'Delete a To Do task after approval.'],
  'todo.checklist': ['GET', 'me/todo/lists/{list}/tasks/{id}/checklistItems', [], 'Read checklist items; preserves pagination links.'],
  'todo.add_checklist': ['POST', 'me/todo/lists/{list}/tasks/{id}/checklistItems', ['displayName','isChecked'], 'Add a task checklist item after approval.'],
  'todo.update_checklist': ['PATCH', 'me/todo/lists/{list}/tasks/{id}/checklistItems/{item}', ['displayName','isChecked'], 'Update or check a checklist item after approval.'],
  'todo.delete_checklist': ['DELETE', 'me/todo/lists/{list}/tasks/{id}/checklistItems/{item}', [], 'Delete a task checklist item after approval.'],
  'todo.links': ['GET', 'me/todo/lists/{list}/tasks/{id}/linkedResources', [], 'Read task linked resources.'],
  'todo.add_link': ['POST', 'me/todo/lists/{list}/tasks/{id}/linkedResources', ['webUrl','applicationName','displayName','externalId'], 'Add a linked resource after approval.'],
  'todo.delete_link': ['DELETE', 'me/todo/lists/{list}/tasks/{id}/linkedResources/{item}', [], 'Delete a linked resource after approval.'],
};
const QUERY_KEYS = new Set(['pageToken','pageSize','maxResults','format','fields','q','cursor','limit','channel','ts','types','exclude_archived','include_all_metadata','start_cursor','page_size','page','per_page','$top','$skiptoken']);
function spec(name) {
  const [method, route, fields, help] = OPERATIONS[name];
  const write = method !== 'GET' && name !== 'notion.query';
  const selectors = [...route.matchAll(/\{(\w+)\}/g)].map(match => match[1]);
  return { method, route, fields, help, write, selectors };
}
function params(name) {
  const op = spec(name);
  return [...op.selectors.map(name => ({ name, type: 'string', required: true, nonempty: true, maxLength: 256 })),
    ...(op.fields.length ? [{ name: 'body', type: 'object', required: true }] : []),
    ...(op.method === 'GET' ? [{ name: 'query', type: 'object' }] : [])];
}
function buildTools(request, providers = null) {
  return Object.fromEntries(Object.keys(OPERATIONS).filter(name => !providers || providers.includes(name.split('.')[0])).map(name => {
    const op = spec(name), provider = name.split('.')[0];
    return [name, { class: op.write ? 'write' : 'browse', tier: 'reach', lazyHelp: true, approval: op.write, budget: 30000,
      help: op.help + (op.fields.length ? ' body accepts: ' + op.fields.join(', ') + '. Use the provider API field shapes.' : '') + ' Use returned IDs; never guess. Pagination is not complete until no next-page link/cursor remains. Provider permissions still apply.',
      example: { action: name, ...Object.fromEntries(op.selectors.map(key => [key, key + '-id'])), ...(op.fields.length ? { body: {} } : {}) },
      async execute(args, ctx) {
        const route = op.route.replace(/\{(\w+)\}/g, (_, key) => {
          const value = args[key];
          if (typeof value !== 'string' || !value.trim() || value.length > 256 || ['.','..'].includes(value)) throw new Error('A valid ' + key + ' ID is required.');
          return encodeURIComponent(value);
        });
        let body;
        if (op.fields.length) {
          if (!args.body || typeof args.body !== 'object' || Array.isArray(args.body)) throw new Error('Supply a body object with the documented provider fields.');
          for (const key of Object.keys(args.body)) if (!op.fields.includes(key)) throw new Error('Unsupported body field: ' + key);
          if (!Object.keys(args.body).length && name !== 'notion.query' && name !== 'drive.copy') throw new Error('Supply at least one body field.');
          body = { ...args.body };
          if (['discord.send','discord.update'].includes(name)) body.allowed_mentions = { parse: [], replied_user: false };
          if (name === 'drive.create_folder') body.mimeType = 'application/vnd.google-apps.folder';
        }
        const query = {};
        if (args.query && (typeof args.query !== 'object' || Array.isArray(args.query))) throw new Error('query must be an object.');
        for (const [key, value] of Object.entries(args.query || {})) {
          if (!QUERY_KEYS.has(key) || !['string','number','boolean'].includes(typeof value)) throw new Error('Unsupported query parameter: ' + key);
          query[key] = String(value);
        }
        const config = (ctx.getPlugins?.() || ctx.getSettings?.().plugins || {})[provider];
        const result = await request(provider, config, route, { method: op.method, body, ...(Object.keys(query).length ? { query } : {}), signal: ctx.signal });
        return { ok: true, result };
      } }];
  }));
}
module.exports = { OPERATIONS, params, buildTools };
