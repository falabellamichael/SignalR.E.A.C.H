'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const os = require('node:os');
const { PersonaStore } = require('../agent/persona-store.cjs');
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/member-designs.js'), 'utf8'), context);
const designs = context.window.ReachMemberDesigns;

test('every feature choice survives storage and renderer resolution', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-design-test-'));
  try {
    const file = path.join(root, 'personas.json');
    const store = new PersonaStore(file);
    const persona = store.createPersona({ name: 'Builder', prompt: 'Build carefully.' });
    const team = store.createTeam({ name: 'Crew', members: [{ personaId: persona.id, designId: 'bot-50' }] });
    assert.equal(store.getTeam(team.id).members[0].designId, 'bot-50');
    for (const [key, values] of Object.entries(designs.choices)) {
      for (const value of values) {
        const id = designs.encode({ ...designs.config('bot-01'), [key]: value });
        store.updateTeam(team.id, { members: [{ personaId: persona.id, designId: id }] });
        const member = new PersonaStore(file).listTeams()[0].members[0];
        assert.equal(member.designId, id);
        assert.equal(designs.config(designs.resolve(member).id)[key], value);
        assert.equal(member.personaPrompt, 'Build carefully.');
        assert.match(designs.svg(id), /<svg/);
        assert.doesNotMatch(designs.svg(id), /undefined/);
      }
    }
    store.updateTeam(team.id, { members: [{ personaId: persona.id, designId: 'bot-v1-<script>' }] });
    assert.equal(store.getTeam(team.id).members[0].designId, '');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('changing one part preserves all other parts and rejects unsafe colors', () => {
  const original = designs.config('bot-23');
  const changed = designs.config(designs.encode({ ...original, eyes: 'wink', accent: '#123ABC' }));
  assert.equal(changed.eyes, 'wink');
  assert.equal(changed.accent, '#123abc');
  for (const key of ['mouth', 'top', 'shape', 'bg', 'ink']) assert.equal(changed[key], original[key]);
  const unsafe = designs.encode({ ...original, ink: '\" onload=\"alert(1)' });
  assert.doesNotMatch(designs.svg(unsafe), /onload/);
  assert.equal(designs.all().length, 50);
});
