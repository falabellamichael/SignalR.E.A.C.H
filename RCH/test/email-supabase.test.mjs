import { defineEmailSuite } from './helpers/email-suite.mjs';
import { pgliteStores } from './helpers/pglite-store.mjs';

// Email sign-in in SQL, executed for real against every committed migration.
const postgres = pgliteStores({ requiredMigration: '_rch_email_sign_in.sql' });
defineEmailSuite('postgres', { fresh: options => postgres.fresh(options) });
