'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
require('../SignalREACH-website/assets/workspace-core.js');
const core = globalThis.SignalREACHWorkspaceCore;

test('document mode requests prose files and preserves website mode', () => {
  const files = {'document.md':'# Draft'};
  assert.match(core.messages('Write a report', files, [], true)[0].content, /real Word .docx/);
  assert.match(core.messages('Build a site', core.starter)[0].content, /responsive layouts/);
  const edit = core.proposal('Ready for review.\n```file:report.md\n# Report\n\nFinished prose.\n```', files);
  assert.equal(core.apply(edit, files)['report.md'], '# Report\n\nFinished prose.');
});

test('export is a valid ZIP/OOXML document with correct CRCs, headings and Unicode text', async () => {
  const blob = core.docx('# A & B <report>\n\nHello, caf\u00e9 \ud83c\udf31.\nSecond line.\n\n## Actions\n\n- First\n1. Second\n\n<script>alert(1)</script>\u0001');
  assert.equal(blob.type, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const result = spawnSync('python', ['-c', `
import sys, io, zipfile, xml.etree.ElementTree as ET
z = zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))
assert z.testzip() is None
assert set(z.namelist()) == {'[Content_Types].xml', '_rels/.rels', 'word/document.xml'}
for name in z.namelist(): ET.fromstring(z.read(name))
ns = {'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
root = ET.fromstring(z.read('word/document.xml'))
texts = [e.text for e in root.findall('.//w:t', ns)]
assert texts == ['A & B <report>', 'Hello, caf\\u00e9 \\U0001f331. Second line.', 'Actions', '- First', '1. Second', '<script>alert(1)</script>'], texts
assert len(root.findall('.//w:outlineLvl', ns)) == 2
rels = ET.fromstring(z.read('_rels/.rels'))
assert rels[0].attrib['Target'] == 'word/document.xml'
print('Valid Word package')
`], {input:Buffer.from(await blob.arrayBuffer()), encoding:'utf8'});
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('export enforces text limit and preview treats markup as literal text', () => {
  assert.throws(() => core.docx('x'.repeat(512 * 1024 + 1)), /export limit/);
  assert.deepEqual(core.documentBlocks('# Title\n\n<script>bad()</script>'), [{type:'h1',text:'Title'}, {type:'p',text:'<script>bad()</script>'}]);
});
