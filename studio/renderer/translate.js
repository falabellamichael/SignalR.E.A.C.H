'use strict';
/*
 * Reach Studio — Translate: language detection and prompt construction.
 *
 * Kept pure and dual-loaded (browser + CommonJS) so the renderer and its Node
 * tests share one implementation. Detection is deliberately LOCAL and offline:
 * translating a private message must not begin by shipping the message to a
 * third-party detector, and a network round-trip just to fill in a label makes
 * the popover feel broken.
 *
 * The detector is heuristic by design. It reports a confidence so the UI can
 * say "Detected — German" when it is sure and "Detected — possibly German"
 * when it is guessing off weak evidence, and it can also say it does not know.
 */

(function expose(factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ReachTranslate = api;
})(function buildTranslate() {
  /* Script ranges. Each entry is [regex, code, weight]: a script match is strong
   * evidence because these writing systems belong to few languages. */
  const SCRIPTS = [
    [/[\u3040-\u309f\u30a0-\u30ff]/, 'ja', 6],            // Hiragana / Katakana
    [/[\uac00-\ud7af\u1100-\u11ff]/, 'ko', 6],            // Hangul
    [/[\u4e00-\u9fff]/, 'zh-Hans', 3],                    // Han (shared; weak alone)
    [/[\u0400-\u04ff]/, 'ru', 3],                         // Cyrillic (shared; weak alone)
    [/[\u0600-\u06ff\u0750-\u077f]/, 'ar', 4],            // Arabic
    [/[\u0590-\u05ff]/, 'he', 6],                         // Hebrew
    [/[\u0e00-\u0e7f]/, 'th', 6],                         // Thai
    [/[\u0e80-\u0eff]/, 'lo', 6],                         // Lao
    [/[\u1000-\u109f]/, 'my', 6],                         // Myanmar
    [/[\u0900-\u097f]/, 'hi', 3],                         // Devanagari (shared; weak alone)
    [/[\u0370-\u03ff\u1f00-\u1fff]/, 'el', 6],          // Greek
    [/[\u0530-\u058f]/, 'hy', 6],                         // Armenian
    [/[\u0980-\u09ff]/, 'bn', 6],                         // Bengali
    [/[\u0a00-\u0a7f]/, 'pa', 6],                         // Gurmukhi
    [/[\u0a80-\u0aff]/, 'gu', 6],                         // Gujarati
    [/[\u0b00-\u0b7f]/, 'or', 6],                         // Oriya
    [/[\u0b80-\u0bff]/, 'ta', 6],                         // Tamil
    [/[\u0c00-\u0c7f]/, 'te', 6],                         // Telugu
    [/[\u0c80-\u0cff]/, 'kn', 6],                         // Kannada
    [/[\u0d00-\u0d7f]/, 'ml', 6],                         // Malayalam
    [/[\u0d80-\u0dff]/, 'si', 6],                         // Sinhala
    [/[\u0e00-\u0e7f]/, 'th', 6],
    [/[\u10a0-\u10ff]/, 'ka', 6],                         // Georgian
    [/[\u1200-\u137f]/, 'am', 6],                         // Ethiopic
    [/[\u1780-\u17ff]/, 'km', 6],                         // Khmer
    [/[\u1e00-\u1eff]/, 'vi', 2],                         // Vietnamese additions (weak)
    [/[\u3040-\u30ff]/, 'ja', 6],
    [/[\uff00-\uffef]/, 'ja', 1],                         // Halfwidth forms (weak)
    [/[\u00c0-\u024f]/, null, 0],                         // Latin diacritics: resolved by words
  ];

  /* Function words. These are the highest-signal short tokens in a language and
   * they survive in almost any sentence, which is what makes them useful for a
   * local detector. Kept to unambiguous words: a token shared by two languages
   * belongs in neither list. */
  const STOPWORDS = {
    en: ['the', 'and', 'is', 'are', 'was', 'were', 'of', 'to', 'in', 'that', 'it', 'for', 'with', 'this', 'you', 'not', 'but', 'have', 'has', 'be', 'on', 'as', 'at', 'by', 'from', 'or', 'we', 'they', 'will', 'can', 'if', 'your'],
    es: ['el', 'la', 'los', 'las', 'de', 'que', 'y', 'en', 'un', 'una', 'es', 'por', 'con', 'para', 'no', 'se', 'su', 'al', 'del', 'como', 'pero', 'más', 'este', 'esta', 'son', 'está', 'hay', 'muy', 'también', 'pero', 'porque'],
    fr: ['le', 'la', 'les', 'des', 'de', 'du', 'et', 'est', 'un', 'une', 'que', 'qui', 'dans', 'pour', 'pas', 'sur', 'avec', 'au', 'aux', 'ce', 'cette', 'sont', 'être', 'vous', 'nous', 'mais', 'plus', 'tout', 'fait', 'comme'],
    de: ['der', 'die', 'das', 'und', 'ist', 'ein', 'eine', 'nicht', 'mit', 'den', 'dem', 'des', 'zu', 'auf', 'für', 'sich', 'auch', 'als', 'noch', 'bei', 'aus', 'wird', 'sind', 'wenn', 'aber', 'oder', 'wie', 'wir', 'sie', 'ich'],
    it: ['il', 'lo', 'la', 'gli', 'le', 'di', 'del', 'che', 'e', 'un', 'una', 'è', 'per', 'con', 'non', 'si', 'sono', 'come', 'ma', 'anche', 'più', 'questo', 'questa', 'nel', 'alla', 'della'],
    pt: ['o', 'a', 'os', 'as', 'de', 'do', 'da', 'que', 'e', 'um', 'uma', 'é', 'para', 'com', 'não', 'se', 'são', 'como', 'mas', 'mais', 'este', 'esta', 'pelo', 'pela', 'ao', 'dos', 'das', 'olá', 'você', 'tudo', 'bem', 'obrigado', 'sim', 'aqui', 'agora', 'depois', 'muito', 'também', 'está', 'foi', 'ser'],
    nl: ['de', 'het', 'een', 'en', 'van', 'is', 'dat', 'op', 'te', 'voor', 'met', 'niet', 'zijn', 'er', 'aan', 'ook', 'als', 'maar', 'om', 'dan', 'je', 'we', 'ze', 'zich'],
    sv: ['och', 'att', 'det', 'som', 'en', 'är', 'på', 'för', 'med', 'av', 'den', 'till', 'inte', 'har', 'de', 'om', 'ett', 'han', 'men', 'var', 'jag', 'sig', 'tack', 'din', 'ditt', 'hjälp', 'hej', 'hur', 'mår', 'bra', 'hoppas', 'allt', 'mycket'],
    da: ['og', 'at', 'det', 'er', 'en', 'til', 'på', 'de', 'med', 'den', 'for', 'af', 'ikke', 'der', 'som', 'har', 'om', 'et', 'man', 'kan', 'vi'],
    nb: ['og', 'i', 'jeg', 'det', 'at', 'en', 'et', 'den', 'til', 'er', 'som', 'på', 'de', 'med', 'han', 'av', 'ikke', 'der', 'så', 'var', 'meg', 'seg', 'men', 'ett', 'har', 'om', 'vi', 'min', 'mitt', 'du', 'da', 'for', 'å'],
    fi: ['ja', 'on', 'ei', 'se', 'että', 'oli', 'hän', 'ne', 'kun', 'niin', 'myös', 'mutta', 'tai', 'jos', 'kuin', 'sen', 'olla', 'ovat'],
    pl: ['nie', 'się', 'jest', 'że', 'na', 'do', 'to', 'w', 'z', 'i', 'o', 'dla', 'jak', 'ale', 'tak', 'już', 'tylko', 'przez', 'być', 'są', 'może'],
    cs: ['je', 'se', 'na', 'to', 'že', 'v', 'a', 's', 'z', 'do', 'pro', 'ale', 'tak', 'jako', 'jsou', 'byl', 'byla', 'nebo', 'které', 'který', 'jak', 'máte', 'dobrý', 'děkuji', 'ano', 'ne', 'jsem', 'jste', 'prosím', 'den'],
    sk: ['je', 'sa', 'na', 'to', 'že', 'v', 'a', 's', 'z', 'do', 'pre', 'ale', 'tak', 'ako', 'sú', 'bol', 'bola', 'alebo', 'ktoré', 'ktorý'],
    hu: ['a', 'az', 'és', 'hogy', 'nem', 'is', 'egy', 'van', 'mint', 'de', 'meg', 'csak', 'vagy', 'már', 'még', 'ez', 'azt', 'volt', 'köszönöm', 'szépen', 'kérem', 'segítséget', 'segít', 'szép', 'napot', 'helló', 'szia', 'jól', 'nagyon', 'minden', 'igen', 'mert', 'most'],
    ro: ['și', 'de', 'la', 'a', 'în', 'este', 'cu', 'pe', 'nu', 'un', 'o', 'care', 'sau', 'dar', 'mai', 'pentru', 'din', 'sunt', 'fost', 'ce', 'faci', 'bună', 'ziua', 'mulțumesc', 'da', 'nu', 'sunt', 'eu', 'tu', 'el', 'noi', 'voi'],
    ru: ['и', 'в', 'не', 'на', 'что', 'я', 'с', 'он', 'как', 'а', 'то', 'все', 'она', 'так', 'его', 'но', 'да', 'ты', 'к', 'у', 'же', 'вы', 'за', 'бы', 'по', 'её'],
    uk: ['і', 'в', 'не', 'на', 'що', 'я', 'з', 'він', 'як', 'а', 'то', 'все', 'вона', 'так', 'його', 'але', 'та', 'ти', 'до', 'у', 'ж', 'ви', 'за', 'б', 'по', 'її'],
    tr: ['bir', 've', 'bu', 'için', 'ile', 'de', 'da', 'ama', 'çok', 'daha', 'olarak', 'gibi', 'kadar', 'sonra', 'ne', 'var', 'yok', 'ise'],
    id: ['yang', 'dan', 'di', 'itu', 'ini', 'untuk', 'dengan', 'tidak', 'dari', 'pada', 'adalah', 'akan', 'juga', 'bisa', 'sudah', 'atau', 'karena', 'seperti', 'halo', 'terima', 'kasih', 'banyak', 'atas', 'bantuan', 'saya', 'kamu', 'anda', 'apa', 'ini', 'ada', 'ke', 'oleh', 'telah', 'lebih', 'sangat', 'hanya', 'sebagai', 'agar', 'supaya', 'tapi', 'tetapi', 'namun', 'jika', 'kalau', 'ketika', 'saat', 'setelah', 'sebelum', 'semua', 'para', 'orang', 'hari', 'baik', 'selamat', 'pagi', 'siang', 'malam', 'ya', 'tidak', 'belum', 'masih', 'sedang', 'akan', 'harus', 'dapat', 'mau', 'ingin', 'suka', 'saja', 'juga', 'pula', 'lagi', 'kembali', 'sini', 'sana', 'mana', 'siapa', 'kapan', 'bagaimana', 'mengapa', 'berapa'],
    ms: ['yang', 'dan', 'di', 'itu', 'ini', 'untuk', 'dengan', 'tidak', 'dari', 'pada', 'ialah', 'akan', 'juga', 'boleh', 'sudah', 'atau', 'kerana', 'seperti'],
    vi: ['và', 'của', 'là', 'có', 'không', 'được', 'trong', 'cho', 'một', 'những', 'này', 'với', 'để', 'người', 'như', 'khi', 'đã', 'sẽ', 'xin', 'chào', 'bạn', 'cảm', 'ơn', 'tôi', 'chúng', 'họ'],
    tl: ['ang', 'ng', 'sa', 'na', 'ay', 'mga', 'ito', 'hindi', 'para', 'ako', 'siya', 'kami', 'kayo', 'sila', 'pero', 'dahil', 'kapag'],
    sw: ['na', 'ya', 'wa', 'kwa', 'ni', 'katika', 'hii', 'hiyo', 'sana', 'lakini', 'pia', 'kama', 'baada', 'watu', 'kazi'],
    af: ['die', 'en', 'van', 'is', 'in', 'het', 'nie', 'met', 'op', 'vir', 'aan', 'ook', 'maar', 'om', 'dan', 'wat', 'ons', 'hulle'],
    el: ['και', 'το', 'η', 'ο', 'τα', 'των', 'που', 'να', 'με', 'για', 'δεν', 'είναι', 'από', 'στο', 'στη', 'αλλά', 'αυτό', 'όπως'],
    he: ['של', 'את', 'לא', 'הוא', 'היא', 'על', 'עם', 'זה', 'זו', 'אני', 'אתה', 'אנחנו', 'הם', 'אבל', 'כי', 'גם', 'כל'],
    ar: ['في', 'من', 'على', 'أن', 'إلى', 'هذا', 'هذه', 'التي', 'الذي', 'كان', 'لا', 'ما', 'هو', 'هي', 'مع', 'عن', 'لكن', 'أو', 'كل'],
    fa: ['و', 'در', 'به', 'از', 'که', 'این', 'را', 'است', 'برای', 'با', 'می', 'شود', 'تا', 'هم', 'یا', 'بر', 'آن'],
    hi: ['और', 'है', 'का', 'के', 'की', 'में', 'को', 'से', 'पर', 'यह', 'वह', 'नहीं', 'हो', 'था', 'लिए', 'साथ', 'भी'],
    ja: ['の', 'に', 'は', 'を', 'た', 'が', 'で', 'て', 'と', 'し', 'れ', 'さ', 'ある', 'いる', 'も', 'する', 'から', 'ない', 'こと', 'これ', 'それ'],
    ko: ['이', '그', '저', '것', '수', '있다', '없다', '하다', '되다', '에서', '으로', '하고', '그리고', '하지만', '때문에'],
    zh: ['的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这'],
    yue: ['嘅', '咗', '唔', '係', '佢', '哋', '喺', '啲', '嗰', '乜', '嘢', '邊'],
  };

  /* Code-point ranges that prove one language. `marks(code)` returns the ranges
   * a detector may use for that language, which lets a language that owns its
   * diacritics keep them while the points shared between relatives stay out of
   * every list. Ranges must not overlap: `á` is Spanish AND Portuguese, so it
   * proves neither, while `ã`/`ê` are Portuguese and `ñ`/`¿` are Spanish. */
  const DIACRITICS = [
    ['vi', /[đơư]|[ạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i],
    ['tr', /[ğış]/i],
    ['pt', /[ãõ]/i],
    ['es', /[ñ¿¡]/i],
    ['fr', /[œçèêùîôûë]/i],
    ['de', /[äöüß]/i],
    ['pl', /[łżźćńśęą]/i],
    ['cs', /[řěščžďťňů]/i],
    ['ro', /[ăâîșț]/i],
    ['hu', /[őű]/i],
    ['da', /[æøå]/i],
    ['uk', /[іїєґ]/i],
  ];
  const MARKS = new Map(DIACRITICS.map(([code, pattern]) => [code, pattern]));

  const CACHE_LIMIT = 200;
  const cache = new Map();

  function tokens(text) {
    return String(text || '').toLowerCase().match(/[\p{L}\p{M}']+/gu) || [];
  }

  function tallyScripts(text) {
    const scores = new Map();
    let letters = 0;
    let nonScriptLetters = 0;
    for (const character of String(text || '')) {
      if (!/\p{L}/u.test(character)) continue;
      letters++;
      let matched = false;
      for (const [pattern, code, weight] of SCRIPTS) {
        if (!pattern.test(character)) continue;
        matched = true;
        if (code) scores.set(code, (scores.get(code) || 0) + weight);
        break;
      }
      if (!matched) nonScriptLetters++;
    }
    return { scores, letters, latin: nonScriptLetters };
  }

  function tallyWords(list, scriptHint) {
    const counts = new Map();
    let hits = 0;
    for (const token of list) {
      let matched = false;
      for (const [code, words] of Object.entries(STOPWORDS)) {
        if (!words.includes(token)) continue;
        // A shared word is evidence for EVERY language that uses it (`como` is
        // Spanish and Portuguese), so the winner is whichever gathers the most
        // evidence overall rather than whichever list is scanned first.
        if (scriptHint && code === scriptHint) counts.set(code, (counts.get(code) || 0) + 2);
        else counts.set(code, (counts.get(code) || 0) + 1);
        matched = true;
      }
      if (matched) hits++;
    }
    return { counts, hits };
  }

  /* Detects the dominant language of `text`.
   * Returns { code, name, native, confidence, source } where confidence is
   * 0..1 and source says which evidence decided it ('script' | 'words' | 'none'). */
  function detect(text, catalog) {
    const value = String(text || '').trim();
    if (!value) return { code: '', name: '', native: '', confidence: 0, source: 'none' };
    const key = value.slice(0, 400);
    if (cache.has(key)) return cache.get(key);

    const list = tokens(value);
    const { scores, letters, latin } = tallyScripts(value);
    let best = null;
    for (const [code, score] of scores) if (!best || score > best.score) best = { code, score };

    let result;
    if (best && best.score >= 6) {
      // A strong script match: enough on its own for these writing systems.
      result = { code: best.code, confidence: 0.92, source: 'script' };
    } else {
      const { counts, hits } = tallyWords(list, best?.code);
      const marked = prefillDiacritics(value, counts, best?.code);
      // Diacritics are real evidence: a short Turkish sentence may carry no
      // stopword at all but its dotless i and ş are decisive on their own.
      const evidence = hits + marked;
      let wordBest = null;
      for (const [code, score] of counts) if (!wordBest || score > wordBest.score) wordBest = { code, score };
      if (wordBest && evidence >= 2) {
        const share = Math.min(1, evidence / Math.max(4, list.length));
        result = { code: wordBest.code, confidence: Math.min(0.95, 0.55 + share * 0.4), source: 'words' };
      } else if (best && best.score >= 3) {
        // Han / Cyrillic / Devanagari with no word evidence: a real but hedged guess.
        result = { code: best.code, confidence: 0.45, source: 'script' };
      } else if (wordBest && evidence === 1) {
        result = { code: wordBest.code, confidence: 0.35, source: 'words' };
      } else if (latin >= letters && letters > 0) {
        // Latin script with no stopword overlap: almost certainly English or a
        // language we cannot separate locally. Say English at low confidence.
        result = { code: 'en', confidence: 0.3, source: 'words' };
      } else {
        result = { code: '', confidence: 0, source: 'none' };
      }
    }

    // Accept either the catalog module (`get(code)`) or the bare array of
    // languages, so a caller cannot silently lose the display name by passing
    // the list it already has.
    const entry = catalog?.get?.(result.code)
      || (Array.isArray(catalog) ? catalog.find(l => l.code === result.code) : null)
      || null;
    const detection = Object.freeze({
      code: entry ? entry.code : result.code,
      name: entry ? entry.name : '',
      native: entry ? entry.native : '',
      confidence: result.confidence,
      source: result.source,
    });
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(key, detection);
    return detection;
  }

  function prefillDiacritics(value, counts, skip) {
    let marked = 0;
    for (const [code, pattern] of DIACRITICS) {
      // A language the word tally already chained cannot be proved by the marks
      // its own stopwords carry, or every language with an accented stopword
      // would prove itself and outrank the real match.
      if (code === skip) continue;
      if (!pattern.test(value)) continue;
      counts.set(code, (counts.get(code) || 0) + 2);
      marked++;
    }
    return marked;
  }

  /* The instruction handed to the model. Asking for ONLY the translation keeps
   * the reply usable as-is, and the explicit "no notes" clause is what stops a
   * chatty model from wrapping it in commentary we would have to strip. */
  function prompt({ text, targetName, sourceName, preserveFormatting = true }) {
    const from = sourceName ? `from ${sourceName} ` : '';
    const lines = [
      `Translate the following message ${from}into ${targetName}.`,
      'Reply with only the translation: no notes, no quotes, no language labels.',
    ];
    if (preserveFormatting) lines.push('Preserve the original line breaks, lists, code blocks and inline code exactly.');
    lines.push('If a term has no established translation, keep the original term rather than inventing one.');
    lines.push('', String(text ?? ''));
    return lines.join('\n');
  }

  /* A model told to "reply with the translation only" still sometimes adds a
   * preamble; strip the common wrappers without harming a genuine translation.
   * Quotes are only unwrapped when they WRAP the whole reply: `"Hola", dijo.`
   * is a sentence someone asked to translate, not a quoting style to undo. */
  function clean(reply) {
    let out = String(reply ?? '').trim();
    if (!out) return '';
    out = out.replace(/^```[a-z-]*\s*\n([\s\S]*?)\n?```$/i, '$1').trim();
    out = out.replace(/^(?:here(?:'s| is)[^\n:]*:|translation\s*:\s*|translated[^\n:]*:)\s*/i, '').trim();
    for (const [open, close] of [['"', '"'], ['“', '”']]) {
      if (out.length < 2 || !out.startsWith(open) || !out.endsWith(close)) continue;
      const inner = out.slice(1, -1);
      // Unwrap only when the marks are the outer pair and nothing else quotes.
      if (!inner.includes(open) && !inner.includes(close)) out = inner.trim();
    }
    return out;
  }

  return Object.freeze({ detect, prompt, clean, tokens, SCRIPTS, STOPWORDS });
});