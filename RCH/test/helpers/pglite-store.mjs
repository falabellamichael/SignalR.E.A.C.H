// A SupabaseAccountStore backed by an embedded PostgreSQL with every committed
// migration applied in order. Every call goes through the real adapter and the
// real RPC functions; no SQL is reimplemented in a test. It does not prove
// multi-session lock scheduling on a hosted database.
import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { SupabaseAccountStore } from '../../service/supabase-store.mjs';

const RPCS = new Set(['reach_account_store', 'reach_request_store', 'reach_payment_store', 'reach_payment_reversal_store']);
const quote = value => { assert.match(value, /^[a-z_][a-z0-9_]*$/); return `"${value}"`; };

export function pgliteStores({ requiredMigration } = {}) {
  let db;
  before(async () => {
    db = await PGlite.create();
    await db.exec('CREATE ROLE anon NOINHERIT; CREATE ROLE authenticated NOINHERIT; CREATE ROLE service_role NOINHERIT BYPASSRLS;');
    const directory = new URL('../../../supabase/migrations/', import.meta.url);
    const files = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
    if (requiredMigration) assert.ok(files.some(name => name.endsWith(requiredMigration)), `${requiredMigration} is part of the chain under test`);
    for (const file of files) await db.exec(await readFile(new URL(file, directory), 'utf8'));
  });
  after(async () => { await db?.close(); });

  return {
    query: (...args) => db.query(...args),
    async fresh({ models, subscription }) {
      // Not every table has a foreign key to accounts, so clear the whole schema.
      const tables = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='reach_accounts'")).rows.map(row => row.tablename);
      await db.exec(`TRUNCATE ${tables.map(table => `reach_accounts.${quote(table)}`).join(', ')} CASCADE`);
      const clock = { now: 1_800_000_000_000 };
      const store = new SupabaseAccountStore({ url: 'https://payments-fixture.supabase.co', secretKey: 'sb_secret_local_test_only_0000000000',
        models, subscription, now: () => clock.now,
        fetchImpl: async (url, options) => {
          const rpc = new URL(url).pathname.split('/').pop();
          assert.ok(RPCS.has(rpc), `unexpected RPC ${rpc}`);
          const { p_operation, p_payload } = JSON.parse(options.body);
          try {
            const result = await db.transaction(async transaction => {
              await transaction.exec('SET LOCAL ROLE service_role');
              const response = await transaction.query(`SELECT public.${quote(rpc)}($1::text,$2::jsonb) AS response`, [p_operation, JSON.stringify(p_payload)]);
              return response.rows[0].response;
            });
            return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
          } catch (error) {
            if (error.code !== 'P0001') console.error('Unexpected SQL failure:', error.code, error.message);
            return new Response(JSON.stringify({ code: error.code, message: error.message }), { status: 400, headers: { 'content-type': 'application/json' } });
          }
        } });
      return { store, clock,
        async setCredit({ accountId, prepaid, debt }) {
          await db.query('UPDATE reach_accounts.accounts SET usd_prepaid=$1,usd_debt=$2 WHERE id=$3', [prepaid, debt, accountId]);
        } };
    },
  };
}
