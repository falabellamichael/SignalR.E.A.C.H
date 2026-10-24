# Hosted welcome trial

Migration `20261023120000_rch_welcome_trial.sql` grants existing Supabase accounts
24 hours from migration activation. Newly inserted accounts receive 24 hours
from insertion, using database time. Login, token refresh and payments do not
restart the clock.

The grant covers qualified request-billed subscription models through the
existing unlimited-request ledger. It does not mint credit, alter roles, fabricate
payments or replace paid plans. Existing debt and model-qualification checks
remain in force. After expiry, normal paid entitlement rules resume.

The allowance exposes `trialActive` and `trialEndsAt`; `plusActive` is also true
while the complimentary trial is active for compatibility with existing clients.
Clients do not yet have a dedicated trial countdown/banner. API-key creation
eligibility is unchanged; this grant is for authenticated member usage.

Activation: 2026-10-23 10:38:13.439 UTC. Four existing accounts were granted access
until 2026-10-24 10:38:13.439 UTC. A rolled-back database transaction verified new
account duration, active allowance, free reservation/release, unchanged plan and
credit fields, and rejection of an expired trial even with an old caller time.
After deployment, all four existing accounts reported trialActive=true.

The live migration was applied individually and recorded in migration history
because older local/remote migration timestamps differ. No migration history was
rewritten. This implementation targets the deployed Supabase account store;
the optional local SQLite development store does not yet implement trials.
