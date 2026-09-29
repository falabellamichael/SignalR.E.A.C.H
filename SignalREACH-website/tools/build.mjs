/** Package the ready-written pages as a static hosting directory. No compilation/dependencies required. */
import {cp, mkdir, rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root,'dist');
await rm(out, {recursive:true,force:true});
await mkdir(out, {recursive:true});
for (const name of ['index.html','platform.html','integrations.html','docs.html','about.html','download.html','assets']) {
  await cp(path.join(root,name),path.join(out,name),{recursive:true});
}
console.log('Static deployment files created in dist/. Upload its contents to a static host.');
