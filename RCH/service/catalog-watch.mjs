// Only model limits/availability reload. Auth, billing and private credentials
// retain their startup values. Invalid edits leave the current catalog intact.
import { lstatSync, readFileSync, watchFile, unwatchFile } from 'node:fs';

export function watchModelCatalog(path, initial, apply, report = message => console.log(message)) {
  let previous = JSON.stringify(initial);
  let rejected = false;
  const refresh = () => {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_000_000) throw new Error('Invalid model file.');
      const models = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')).models;
      const serialized = JSON.stringify(models);
      if (serialized === previous) return;
      apply(models);
      previous = serialized;
      rejected = false;
      report('Subscription model configuration applied.');
    } catch {
      if (!rejected) report('Subscription model update rejected; current configuration retained.');
      rejected = true;
    }
  };
  watchFile(path, { interval: 500, persistent: false }, refresh);
  return () => unwatchFile(path, refresh);
}
