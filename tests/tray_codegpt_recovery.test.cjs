const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../copilot/tray/main.js'), 'utf8');
function section(start, end) { return source.slice(source.indexOf(start), source.indexOf(end)); }

// The sidecar log is how the tray learns the upstream cut a run mid-stream
// (the extension still closes such a run as "done" — 2026-09-21: the last two
// edits of a SUMMARY.md run died exactly this way). The helpers must see the
// marker only inside the window that follows the request's own mark; older
// content and untouched files must never trigger a resume.
test('a terminated CodeGPT stream is detected in the sidecar log window', () => {
 const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-cg-log-'));
 try {
  const dir = path.join(tmp, '.codegpt');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'server.log');
  fs.writeFileSync(file, 'boot\n');
  const helpers = vm.runInNewContext(
   section('const CODEGPT_SIDECAR_LOG', 'function codegptToolLine(')
    + '\n({ codegptSidecarLogSize, codegptStreamCutSince })',
   { fs, path, os: { homedir: () => tmp }, Buffer });
  const mark = helpers.codegptSidecarLogSize();
  assert.equal(mark, 5);
  assert.equal(helpers.codegptStreamCutSince(mark), false);
  fs.appendFileSync(file, '[round-trip] headers in 1993ms — streaming\n'
   + '[stream] Error processing stream chunk: terminated\n');
  assert.equal(helpers.codegptStreamCutSince(mark), true);
  // A quiet file after the mark: nothing to resume.
  assert.equal(helpers.codegptStreamCutSince(fs.statSync(file).size), false);
  // A respawned sidecar truncates the log: the whole file is then newer.
  assert.equal(helpers.codegptStreamCutSince(999999), true);
 } finally {
  fs.rmSync(tmp, { recursive: true, force: true });
 }
});
