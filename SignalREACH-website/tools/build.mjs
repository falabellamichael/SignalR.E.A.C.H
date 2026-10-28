/** Package the ready-written pages as a static hosting directory. No compilation/dependencies required. */
import {cp, mkdir, rm, readFile, writeFile, readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root,'dist');
// Content hashes invalidate shared assets on every page, including the preview.
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex').slice(0, 12);
for (const directory of [root, path.join(root, 'assets')]) {
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.html')) continue;
    const file = path.join(directory, name);
    const original = await readFile(file, 'utf8');
    let content = original;
    for (const match of original.matchAll(/(?:src|href)="((?:assets\/)?[\w./-]+\.(?:js|css))(?:\?[^"#]*)?"/g)) {
      const version = await hash(path.resolve(directory, match[1]));
      content = content.replace(match[0], match[0].replace(/=".*"$/, `="${match[1]}?v=${version}"`));
    }
    if (content !== original) await writeFile(file, content);
  }
}
const previewHost = path.join(root, 'assets/workspace-ui.js');
const previewSource = await readFile(previewHost, 'utf8');
await writeFile(previewHost, previewSource.replace(/workspace-preview\.html\?v=[\w.-]+/g,
  `workspace-preview.html?v=${await hash(path.join(root, 'assets/workspace-preview.html'))}`));
// The preview host changed after hashing HTML; refresh its entrypoint hash.
for (const name of ['index.html', 'demo.html']) {
  const index = path.join(root, name);
  await writeFile(index, (await readFile(index, 'utf8')).replace(/workspace-ui\.js\?v=[\w.-]+/g,
    `workspace-ui.js?v=${await hash(previewHost)}`));
}
await rm(out, {recursive:true,force:true});
await mkdir(out, {recursive:true});
for (const name of ['index.html','welcome.html','demo.html','platform.html','integrations.html','docs.html','about.html','download.html','subscription.html','login.html','profile.html','privacy.html','tty-privacy.html','robots.txt','sitemap.xml','.htaccess','assets']) {
  await cp(path.join(root,name),path.join(out,name),{recursive:true});
}
console.log('Static deployment files created in dist/. Upload its contents to a static host.');
