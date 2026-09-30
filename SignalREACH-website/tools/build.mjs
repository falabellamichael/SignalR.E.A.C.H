/** Bundle the conversation extension with the existing UI, then package the static site. */
import {cp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist');
// Read and validate required source assets before replacing the previous build.
const [conversation, ui] = await Promise.all([
  readFile(path.join(root, 'assets/chat-conversations.js'), 'utf8'),
  readFile(path.join(root, 'assets/chat-ui.js'), 'utf8')
]);
if (!conversation.includes('conversationVersion') || !ui.includes('SignalREACHChatUI')) {
  throw new Error('The conversation extension or chat UI source is missing its expected entry point.');
}
await rm(out, {recursive:true, force:true});
await mkdir(out, {recursive:true});
for (const name of ['index.html','platform.html','integrations.html','docs.html','about.html','download.html','assets']) {
  await cp(path.join(root,name),path.join(out,name),{recursive:true});
}
// chat-engine.js already loads first in index.html. The extension runs before
// the UI mounts, with no extra runtime request and no changes to the base engine.
await writeFile(path.join(out,'assets/chat-ui.js'), `${conversation}\n;\n${ui}`, 'utf8');
console.log('Static deployment files created in dist/ with 50 branching conversation paths.');
