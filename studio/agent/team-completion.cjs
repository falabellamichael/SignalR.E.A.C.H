'use strict';

// Team completion is a runtime decision. Peer mail never grants it, and a
// quoted/example marker must not be interpreted as a control instruction.
function linksCompleteIn(text) {
  const lines = String(text || '').trimEnd().split('\n');
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (fence) {
      if (new RegExp('^ {0,3}' + fence[0] + '{' + fence.length + ',}\\s*$').test(line)) fence = null;
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opening) { fence = opening[1]; continue; }
    if (i === lines.length - 1 && /^ {0,3}LINKS:\s*COMPLETE\s*$/i.test(line)) return true;
  }
  return false;
}

function deliveredContent(output) {
  const text = String(output || '').trim();
  return linksCompleteIn(text) ? text.replace(/(?:^|\n) {0,3}LINKS:\s*COMPLETE\s*$/i, '').trim() : text;
}

function completedResult(result) {
  return result?.ok === true && result.status === 'completed' && !result.error && !!deliveredContent(result.output);
}

module.exports = { linksCompleteIn, deliveredContent, completedResult };
