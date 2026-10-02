import { definePaymentsSuite } from './helpers/payments-suite.mjs';
import { pgliteStores } from './helpers/pglite-store.mjs';

// The SQL implementation of the payment ledger, executed for real against every
// committed migration (see helpers/pglite-store.mjs).
const postgres = pgliteStores({ requiredMigration: '_rch_payments_ledger.sql' });
definePaymentsSuite('postgres', { fresh: options => postgres.fresh(options) });
