'use strict';

// Audit failures must not change a tool or crew decision. Keep every additional
// field in detail: audit-log.cjs has a frozen canonical hash shape.
function auditEvent(log, event, { agent = null, allowed = null, reason = null, detail = {} } = {}) {
  if (!log || typeof log.write !== 'function') return;
  try { log.write({ event, agent, allowed, reason, detail }); } catch { /* advisory sink */ }
}

module.exports = { auditEvent };
