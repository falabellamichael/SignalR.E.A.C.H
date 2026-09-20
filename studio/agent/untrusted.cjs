'use strict';

// JSON escaping preserves the original contents while preventing a file from
// forging the closing delimiter. This is a prompt boundary, NOT a substitute
// for the tool policy and human approval checks enforced by code.
function untrustedData(value) {
  return '<untrusted_data>\n' + JSON.stringify(String(value ?? '')).replace(/</g, '\\u003c') + '\n</untrusted_data>';
}
module.exports = { untrustedData };
