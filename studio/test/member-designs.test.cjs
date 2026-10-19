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
    const animated = designs.encode({ ...designs.config('bot-01'), animation: 'dance' });
    store.updateTeam(team.id, { members: [{ personaId: persona.id, designId: animated }, { personaId: persona.id, role: 'Reviewer', designId: 'bot-50' }] });
    const saved = new PersonaStore(file).getTeam(team.id).members;
    assert.equal(designs.config(designs.resolve(saved[0]).id).animation, 'dance');
    assert.equal(designs.config(designs.resolve(saved[1]).id).animation, 'none');
    store.updateTeam(team.id, { members: [{ personaId: persona.id, designId: animated + '-unsafe' }] });
    assert.equal(store.getTeam(team.id).members[0].designId, '');
    store.updateTeam(team.id, { members: [{ personaId: persona.id, designId: 'bot-v1-<script>' }] });
    assert.equal(store.getTeam(team.id).members[0].designId, '');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('25 unique animations round-trip independently with legacy designs staying still', () => {
  assert.equal(designs.choices.animation.length, 26);
  assert.equal(new Set(designs.choices.animation).size, 26);
  const css = fs.readFileSync(path.join(__dirname, '../renderer/styles.css'), 'utf8');
  const base = designs.config('bot-23');
  assert.equal(base.animation, 'none');
  for (const animation of designs.choices.animation) {
    const id = designs.encode({ ...base, animation });
    assert.ok(designs.get(id));
    assert.deepEqual({ ...designs.config(id) }, { ...base, animation });
    assert.match(designs.svg(id), new RegExp(`data-animation="${animation}"`));
    if (animation !== 'none') {
      assert.ok(css.includes(`@keyframes bot-${animation} `), animation);
      assert.ok(css.includes(`[data-animation="${animation}"]`), animation);
    }
  }
  const invalid = designs.encode({ ...base, animation: 'spin" onload="alert(1)' });
  assert.equal(designs.config(invalid).animation, 'none');
  assert.equal(designs.get(designs.encode(base) + '-unknown'), null);
  assert.match(designs.svg(designs.encode({ ...base, top: 'none', animation: 'antenna' })), /bot-part-fallback/);
  assert.match(designs.svg(designs.encode({ ...base, mouth: 'none', animation: 'chatter' })), /bot-part-fallback/);
});

test('shared actions follow real activity and leave stored idle identities unchanged', () => {
  const { reduce } = require('../agent/activity.cjs');
  let state;
  const event = (type, fields = {}) => { state = reduce(state, { type, ...fields }, 1000); return designs.actionFor(state, 1001); };
  assert.equal(designs.actionFor(null), 'idle');
  assert.equal(event('run-state', {status:'running'}), 'prepare');
  assert.equal(event('request-start'), 'wait');
  assert.equal(event('reasoning', {chars:42}), 'think');
  assert.equal(event('delta', {text:'Hello'}), 'transmit');
  for (const [tool, action] of [['read_file','scan'],['search','scan'],['browser','scan'],['write_file','build'],['apply_patch','build'],['shell','execute'],['send_message','transmit']]) {
    assert.equal(event('tool-call', {tool}), action);
  }
  assert.equal(event('approval-wait'), 'wait');
  assert.equal(event('approval-end'), 'transmit');
  assert.equal(event('tool-result', {ok:true}), 'prepare');
  assert.equal(event('compaction-start'), 'compress');
  assert.equal(designs.actionFor(state, 32000), 'wait');
  assert.equal(event('rate-limit'), 'wait');
  assert.equal(event('run-state', {status:'completed'}), 'complete');
  for (const [status, action] of [['completed','complete'],['error','error'],['failed','error'],['paused','paused'],['stopped','paused'],['stalled','wait']]) {
    assert.equal(designs.actionFor({status,endedAt:1000},2499),action);
    assert.equal(designs.actionFor({status,endedAt:1000},2500),'idle');
    assert.equal(designs.actionFor({status,updatedAt:1000},2501),'idle');
    assert.equal(designs.actionFor({status}),'idle');
  }
  assert.equal(designs.actionFor({status:'waiting_input',updatedAt:1000},10000),'wait');
  assert.equal(designs.actionFor({status:'waiting_edits',updatedAt:1000},10000),'wait');
  assert.equal(designs.actionFor({status:'queued'}), 'wait');
  const attributes = new Map([['aria-label','Test bot']]);
  const svg = { dataset:{}, getAttribute:key=>attributes.get(key), setAttribute:(key,value)=>attributes.set(key,value) };
  designs.applyAction(svg,'think');
  assert.equal(svg.dataset.action,'think');
  assert.match(attributes.get('aria-label'),/Neural orbit/);
  designs.applyAction(svg,'idle');
  assert.equal(attributes.get('aria-label'),'Test bot');
  designs.applyAction(svg,'unsafe');
  assert.equal(svg.dataset.action,'idle');
  assert.equal(designs.choices.animation.length,26);
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
