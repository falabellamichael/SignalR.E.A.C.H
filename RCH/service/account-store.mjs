import { AccountStore } from './store.mjs';
import { SupabaseAccountStore } from './supabase-store.mjs';

/** Keep persistence selection on the account-service host, never in a client. */
export function createAccountStore(config, { now = Date.now, fetchImpl } = {}) {
  if (config.supabase) {
    return new SupabaseAccountStore({
      url: config.supabase.url,
      secretKey: config.supabase.secretKey,
      models: config.models,
      subscription: config.subscription,
      now,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  }
  return new AccountStore(config.database, { models: config.models, subscription: config.subscription, now });
}
