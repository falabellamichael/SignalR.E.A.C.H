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
    // This legacy format has no request ledger. Refuse an incomplete export
    // rather than losing completed quotas, holds, or idempotent responses.
    for (const table of ['request_periods', 'request_reservations']) {
      const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table);
      if (exists && db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) {
        throw new Error('The seven-table account snapshot cannot preserve request billing records. Use a full database backup until request-ledger snapshot migration is supported.');
      }
    }
    const snapshot = Object.fromEntries(accountTables.map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
    db.exec('COMMIT');
    return snapshot;
  } finally {
    db.close();
  }
}
