import { AccountStore } from '../service/store.mjs';
import { definePaymentsSuite } from './helpers/payments-suite.mjs';

// The reference implementation: rules in JavaScript, applied inside one SQLite
// transaction. payments-supabase.test.mjs runs the identical suite against the
// SQL implementation.
definePaymentsSuite('sqlite', {
  async fresh({ models, subscription }) {
    const clock = { now: 1_800_000_000_000 };
    const store = new AccountStore(':memory:', { now: () => clock.now, models, subscription });
    return { store, clock,
      async setCredit({ accountId, prepaid, debt }) {
        store.db.prepare('UPDATE accounts SET usd_prepaid=?,usd_debt=? WHERE id=?').run(prepaid, debt, accountId);
      } };
  },
});
