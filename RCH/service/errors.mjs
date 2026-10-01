// Shared by every store and by the payment core. They live here, not in
// store.mjs, so the payment rules can raise the same errors the account service
// already maps to HTTP responses without importing the SQLite store (which
// imports them back).
export class AccountError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export const fail = (status, code, message) => { throw new AccountError(status, code, message); };
