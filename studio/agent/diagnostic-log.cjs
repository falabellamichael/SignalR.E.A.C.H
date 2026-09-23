'use strict';

// Optional structured diagnostics for headless runs. Never let an observer
// failure change the outcome of an agent action, and never include prompt,
// tool arguments or result bodies in these records.
function diagnosticLog(logger, record) {
  try {
    if (typeof logger === 'function') logger(record);
    else if (logger && typeof logger.write === 'function') logger.write(record);
  } catch { /* diagnostics are best effort */ }
}

module.exports = { diagnosticLog };
