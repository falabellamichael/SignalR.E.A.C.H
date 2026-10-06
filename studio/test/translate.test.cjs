'use strict';

// The message Translate action: language catalog, source detection and the
// translation prompt. Both modules are pure and dual-loaded, so the renderer and
// these tests share one implementation.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const languages = require('../renderer/languages.js');
const translate = require('../renderer/translate.js');

test('the catalog covers the ISO 639-1 set and is lookup-able', () => {
  const { LANGUAGES, get } = languages;
  assert.ok(LANGUAGES.length > 150, `expected a broad catalog, got ${LANGUAGES.length}`);
  // Spot-check the ISO 639-1 set is genuinely present.
  for (const code of ['en', 'es', 'fr', 'de', 'pt', 'it', 'nl', 'pl', 'ru', 'uk', 'tr', 'ar', 'he', 'fa', 'hi', 'bn', 'ta', 'th', 'vi', 'id', 'ja', 'ko', 'zh', 'sw', 'am', 'yo', 'zu']) {
    assert.ok(get(code), `${code} must be in the catalog`);
  }
  // Every row is complete, and codes are unique. Regional and script subtags
  // are allowed (es-419, zh-Hant, pt-BR) because the catalog carries them.
  const seen = new Set();
  for (const l of LANGUAGES) {
    assert.match(l.code, /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,4})?$/, `bad code ${l.code}`);
    assert.ok(l.name && l.native, `${l.code} needs a name and a native name`);
    assert.equal(seen.has(l.code), false, `duplicate code ${l.code}`);
    seen.add(l.code);
  }
});

test('lookups are case-insensitive and tolerate a region tag', () => {
  assert.equal(languages.get('ES').code, 'es');
  assert.equal(languages.get('pt-BR').code.startsWith('pt'), true);
  assert.equal(languages.get('nope'), null);
  assert.equal(languages.displayName('ja'), languages.get('ja').name);
  assert.equal(languages.displayName('nope'), 'nope', 'an unknown code echoes back');
});

test('search matches English names, native names and codes', () => {
  assert.ok(languages.search('spanish').some(l => l.code === 'es'));
  assert.ok(languages.search('español').some(l => l.code === 'es'));
  assert.ok(languages.search('日本').some(l => l.code === 'ja'), 'native search must work');
  assert.ok(languages.search('deutsch').some(l => l.code === 'de'));
  assert.ok(languages.search('es').some(l => l.code === 'es'));
  // Prefix matches rank above contains.
  assert.equal(languages.search('es')[0].code, 'es');
  assert.equal(languages.search('', 5).length, 5, 'an empty query lists the default targets');
  assert.deepEqual(languages.search('zzzzz'), []);
});

test('difficult scripts are detected from their characters alone', () => {
  const cases = [
    ['こんにちは、ありがとうございます。', 'ja'],
    ['안녕하세요 감사합니다', 'ko'],
    ['Привет, спасибо большое за помощь.', 'ru'],
    ['مرحبا، شكرا جزيلا على مساعدتك.', 'ar'],
    ['שלום תודה רבה על העזרה', 'he'],
    ['नमस्ते, आपकी मदद के लिए धन्यवाद।', 'hi'],
    ['สวัสดี ขอบคุณสำหรับความช่วยเหลือ', 'th'],
    ['Γειά σου, ευχαριστώ πολύ για τη βοήθεια.', 'el'],
  ];
  for (const [text, expected] of cases) {
    const found = translate.detect(text, languages.LANGUAGES);
    assert.equal(found?.code, expected, `${JSON.stringify(text)} should be ${expected}, got ${found?.code}`);
  }
});

test('latin-script languages are detected from words and diacritics', () => {
  const cases = [
    ['Hello, how are you today? This is a simple test of the detector.', 'en'],
    ['Bonjour, merci beaucoup pour votre aide, ceci est un test.', 'fr'],
    ['Hola, gracias por tu ayuda, esto es una prueba sencilla.', 'es'],
    ['Olá, obrigado pela sua ajuda, isto é um teste simples.', 'pt'],
    ['Guten Tag, vielen Dank für Ihre Hilfe, das ist ein Test.', 'de'],
    ['Ciao, grazie mille per il tuo aiuto, questo è un test.', 'it'],
    ['Hallo, dank u wel voor uw hulp, dit is een test.', 'nl'],
    ['Cześć, dziękuję bardzo za pomoc, to jest test.', 'pl'],
    ['Merhaba, yardımın için çok teşekkür ederim, bu bir test.', 'tr'],
    ['Hej, tack så mycket för hjälpen, det här är ett test.', 'sv'],
    ['Xin chào, cảm ơn bạn rất nhiều vì đã giúp đỡ.', 'vi'],
    ['Halo, terima kasih banyak atas bantuan Anda.', 'id'],
  ];
  for (const [text, expected] of cases) {
    const found = translate.detect(text, languages.LANGUAGES);
    assert.equal(found?.code, expected, `${JSON.stringify(text.slice(0, 24))}… should be ${expected}, got ${found?.code}`);
  }
});

test('detection reports the evidence and never guesses wildly', () => {
  const strong = translate.detect('Bonjour, merci beaucoup pour votre aide.', languages.LANGUAGES);
  assert.equal(strong.code, 'fr');
  assert.ok(strong.confidence > 0 && strong.confidence <= 1, 'confidence is a probability');
  // The detection names the signal it came from, which is what lets the popover
  // say why it believes the source language.
  assert.ok(['script', 'words', 'none'].includes(strong.source), `unexpected source ${strong.source}`);
  assert.ok(strong.name, 'a detected language is named for display');
  // Too little to go on: no confident answer rather than a wrong one.
  const thin = translate.detect('ok', languages.LANGUAGES);
  assert.ok(!thin || thin.code !== 'ja', 'a one-word ASCII reply is never a CJK detection');
  // Empty input reports "no answer" as an empty code, never a language.
  const empty = translate.detect('', languages.LANGUAGES);
  assert.equal(empty.code, '');
  assert.equal(empty.confidence, 0);
  assert.equal(empty.source, 'none');
  assert.equal(translate.detect(null, languages.LANGUAGES).code, '');
});

test('detection is deterministic and cheap to repeat', () => {
  const text = 'Guten Tag, vielen Dank für Ihre Hilfe, das ist ein Test.';
  const first = translate.detect(text, languages.LANGUAGES);
  for (let i = 0; i < 5; i += 1) assert.deepEqual(translate.detect(text, languages.LANGUAGES), first);
});

test('every language is grouped, with no leftovers', () => {
  const groups = languages.grouped(languages.LANGUAGES);
  assert.ok(groups.length > 8, 'the catalog should be split into several regions');
  const names = groups.map(g => g.name);
  assert.equal(new Set(names).size, names.length, 'group names are unique');
  assert.equal(names.includes('Other'), false, 'nothing may fall outside a region');
  assert.equal(names[0], 'Common', 'the most-wanted languages come first');
  // Common repeats the defaults; every other language appears exactly once.
  const seen = new Map();
  for (const group of groups) {
    for (const language of group.items) seen.set(language.code, (seen.get(language.code) || 0) + 1);
  }
  for (const language of languages.LANGUAGES) {
    assert.ok(seen.has(language.code), `${language.code} is missing from the grouping`);
  }
  for (const target of languages.DEFAULT_TARGETS) {
    assert.equal(seen.get(target.code), 2, `${target.code} belongs to Common and its region`);
  }
  // The regions a user would look in must be where they expect.
  // A language appears once in Common and once in its region, so look for the
  // region by skipping the Common group.
  const regionOf = code => groups.filter(g => g.name !== 'Common')
    .find(g => g.items.some(l => l.code === code))?.name;
  assert.equal(regionOf('ja'), 'East Asia');
  assert.equal(regionOf('sw'), 'Africa');
  assert.equal(regionOf('ru'), 'Eastern Europe');
  assert.equal(regionOf('es'), 'Western Europe');
  assert.equal(regionOf('eo'), 'Constructed');
});

test('groups are alphabetical, except Common', () => {
  const groups = languages.grouped(languages.LANGUAGES);
  for (const group of groups) {
    if (group.name === 'Common') continue;
    const names = group.items.map(l => l.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b, 'en'));
    assert.deepEqual(names, sorted, `${group.name} must be sorted by name`);
  }
  assert.deepEqual(groups[0].items.map(l => l.code), languages.DEFAULT_TARGETS.map(l => l.code));
});

test('the prompt names the direction and protects formatting', () => {
  const out = translate.prompt({ text: 'Hola mundo', targetName: 'English', sourceName: 'Spanish' });
  assert.match(out, /Spanish/);
  assert.match(out, /English/);
  assert.match(out, /code blocks/i, 'formatting is preserved by default');
  assert.ok(out.trimEnd().endsWith('Hola mundo'), 'the message text comes last');

  const noFormat = translate.prompt({ text: 'x', targetName: 'French', preserveFormatting: false });
  assert.doesNotMatch(noFormat, /code blocks/i);
});

test('the prompt asks for a translation, not a commentary', () => {
  const out = translate.prompt({ text: 'x', targetName: 'Japanese' });
  assert.match(out, /only the translation/i);
  // An undetermined source is stated as such rather than guessed at.
  const auto = translate.prompt({ text: 'x', targetName: 'German', sourceName: 'Auto-detect' });
  assert.match(auto, /Auto-detect/);
});

test('clean strips the wrappers a model adds around a translation', () => {
  assert.equal(translate.clean('Translation: "Hello world"'), 'Hello world');
  assert.equal(translate.clean('Here is the translation:\nBonjour le monde'), 'Bonjour le monde');
  assert.equal(translate.clean('```\nHallo Welt\n```'), 'Hallo Welt');
  assert.equal(translate.clean('  Salut  '), 'Salut');
  // A quote that does not wrap the whole reply is part of the sentence, so it
  // survives: `"Hello", she said.` is text, not a quoting style to undo.
  assert.equal(translate.clean('"Hello", she said.'), '"Hello", she said.');
  assert.equal(translate.clean(''), '');
  assert.equal(translate.clean(null), '');
});

test('tokens keeps the words a detector needs', () => {
  assert.deepEqual(translate.tokens('Hola, mundo!'), ['hola', 'mundo']);
  assert.deepEqual(translate.tokens('   '), []);
});