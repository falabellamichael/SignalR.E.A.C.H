import { DatabaseSync } from 'node:sqlite';
import { lstatSync } from 'node:fs';

export const accountTables = ['accounts', 'flows', 'challenges', 'sessions', 'grants', 'reservations', 'redemptions'];

/** Read a consistent snapshot without creating, migrating or altering the source. */
export function readAccountSnapshot(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The source must be a regular SQLite account database.');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('BEGIN');
    const snapshot = Object.fromEntries(accountTables.map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
    db.exec('COMMIT');
    return snapshot;
  } finally {
    db.close();
  }
}
