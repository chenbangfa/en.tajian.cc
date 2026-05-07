const WORD_REGEX = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g;

const IRREGULAR_BASE_MAP = {
    began: 'begin',
    begun: 'begin',
    went: 'go',
    gone: 'go',
    did: 'do',
    done: 'do',
    was: 'be',
    were: 'be',
    been: 'be',
    had: 'have',
    has: 'have',
    ate: 'eat',
    eaten: 'eat',
    saw: 'see',
    seen: 'see',
    came: 'come',
    taken: 'take',
    took: 'take',
    made: 'make',
    found: 'find',
    felt: 'feel',
    kept: 'keep',
    left: 'leave',
    lost: 'lose',
    held: 'hold',
    thought: 'think',
    taught: 'teach',
    built: 'build',
    grew: 'grow',
    grown: 'grow',
    knew: 'know',
    known: 'know',
    ran: 'run',
    written: 'write',
    wrote: 'write'
};

const FALLBACK_ENTRIES = {
    a: { phonetic: '/ə/', pos: 'art.', translation: '一个' },
    an: { phonetic: '/æn/', pos: 'art.', translation: '一个' },
    the: { phonetic: '/ðə/', pos: 'art.', translation: '这/那' },
    and: { phonetic: '/ænd/', pos: 'conj.', translation: '和' },
    or: { phonetic: '/ɔːr/', pos: 'conj.', translation: '或者' },
    but: { phonetic: '/bʌt/', pos: 'conj.', translation: '但是' },
    so: { phonetic: '/soʊ/', pos: 'conj.', translation: '所以' },
    if: { phonetic: '/ɪf/', pos: 'conj.', translation: '如果' },
    when: { phonetic: '/wen/', pos: 'conj.', translation: '当...时' },
    because: { phonetic: '/bɪˈkɔːz/', pos: 'conj.', translation: '因为' },
    in: { phonetic: '/ɪn/', pos: 'prep.', translation: '在...里面' },
    on: { phonetic: '/ɒn/', pos: 'prep.', translation: '在...上面' },
    at: { phonetic: '/æt/', pos: 'prep.', translation: '在' },
    to: { phonetic: '/tuː/', pos: 'prep.', translation: '到/向' },
    from: { phonetic: '/frʌm/', pos: 'prep.', translation: '从' },
    of: { phonetic: '/əv/', pos: 'prep.', translation: '的' },
    with: { phonetic: '/wɪð/', pos: 'prep.', translation: '和/带着' },
    by: { phonetic: '/baɪ/', pos: 'prep.', translation: '通过/在...旁边' },
    for: { phonetic: '/fɔːr/', pos: 'prep.', translation: '为了/给' },
    into: { phonetic: '/ˈɪntuː/', pos: 'prep.', translation: '进入' },
    through: { phonetic: '/θruː/', pos: 'prep.', translation: '穿过/通过' },
    across: { phonetic: '/əˈkrɔːs/', pos: 'prep.', translation: '横穿/遍及' },
    around: { phonetic: '/əˈraʊnd/', pos: 'prep.', translation: '在周围' },
    under: { phonetic: '/ˈʌndər/', pos: 'prep.', translation: '在...下面' },
    over: { phonetic: '/ˈoʊvər/', pos: 'prep.', translation: '在...上方/超过' },
    before: { phonetic: '/bɪˈfɔːr/', pos: 'prep.', translation: '在...之前' },
    after: { phonetic: '/ˈæftər/', pos: 'prep.', translation: '在...之后' },
    while: { phonetic: '/waɪl/', pos: 'conj.', translation: '当...的时候' },
    can: { phonetic: '/kæn/', pos: 'aux.', translation: '能/可以' },
    could: { phonetic: '/kʊd/', pos: 'aux.', translation: '可以/能够' },
    should: { phonetic: '/ʃʊd/', pos: 'aux.', translation: '应该' },
    will: { phonetic: '/wɪl/', pos: 'aux.', translation: '将会' },
    would: { phonetic: '/wʊd/', pos: 'aux.', translation: '会/将' },
    may: { phonetic: '/meɪ/', pos: 'aux.', translation: '可能/可以' },
    might: { phonetic: '/maɪt/', pos: 'aux.', translation: '可能' },
    must: { phonetic: '/mʌst/', pos: 'aux.', translation: '必须' },
    is: { phonetic: '/ɪz/', pos: 'aux.', translation: '是' },
    am: { phonetic: '/æm/', pos: 'aux.', translation: '是' },
    are: { phonetic: '/ɑːr/', pos: 'aux.', translation: '是' },
    was: { phonetic: '/wɒz/', pos: 'aux.', translation: '是（过去式）' },
    were: { phonetic: '/wɜːr/', pos: 'aux.', translation: '是（过去式）' },
    be: { phonetic: '/biː/', pos: 'aux.', translation: '是' },
    been: { phonetic: '/bɪn/', pos: 'aux.', translation: '已经是' },
    being: { phonetic: '/ˈbiːɪŋ/', pos: 'aux.', translation: '正在成为' },
    do: { phonetic: '/duː/', pos: 'v.', translation: '做' },
    does: { phonetic: '/dʌz/', pos: 'v.', translation: '做' },
    did: { phonetic: '/dɪd/', pos: 'v.', translation: '做了' },
    have: { phonetic: '/hæv/', pos: 'v.', translation: '有' },
    has: { phonetic: '/hæz/', pos: 'v.', translation: '有' },
    had: { phonetic: '/hæd/', pos: 'v.', translation: '有（过去式）' },
    i: { phonetic: '/aɪ/', pos: 'pron.', translation: '我' },
    you: { phonetic: '/juː/', pos: 'pron.', translation: '你/你们' },
    he: { phonetic: '/hiː/', pos: 'pron.', translation: '他' },
    she: { phonetic: '/ʃiː/', pos: 'pron.', translation: '她' },
    it: { phonetic: '/ɪt/', pos: 'pron.', translation: '它' },
    we: { phonetic: '/wiː/', pos: 'pron.', translation: '我们' },
    they: { phonetic: '/ðeɪ/', pos: 'pron.', translation: '他们/她们/它们' },
    me: { phonetic: '/miː/', pos: 'pron.', translation: '我（宾格）' },
    us: { phonetic: '/ʌs/', pos: 'pron.', translation: '我们（宾格）' },
    them: { phonetic: '/ðem/', pos: 'pron.', translation: '他们/她们/它们（宾格）' },
    my: { phonetic: '/maɪ/', pos: 'det.', translation: '我的' },
    your: { phonetic: '/jʊr/', pos: 'det.', translation: '你的/你们的' },
    his: { phonetic: '/hɪz/', pos: 'det.', translation: '他的' },
    her: { phonetic: '/hɜːr/', pos: 'det.', translation: '她的/她' },
    our: { phonetic: '/aʊər/', pos: 'det.', translation: '我们的' },
    their: { phonetic: '/ðer/', pos: 'det.', translation: '他们的/她们的/它们的' },
    this: { phonetic: '/ðɪs/', pos: 'det.', translation: '这个' },
    that: { phonetic: '/ðæt/', pos: 'det.', translation: '那个/那' },
    these: { phonetic: '/ðiːz/', pos: 'det.', translation: '这些' },
    those: { phonetic: '/ðoʊz/', pos: 'det.', translation: '那些' },
    each: { phonetic: '/iːtʃ/', pos: 'det.', translation: '每一个' },
    every: { phonetic: '/ˈevri/', pos: 'det.', translation: '每一个' },
    some: { phonetic: '/sʌm/', pos: 'det.', translation: '一些' },
    any: { phonetic: '/ˈeni/', pos: 'det.', translation: '任何/一些' },
    many: { phonetic: '/ˈmeni/', pos: 'det.', translation: '许多' },
    much: { phonetic: '/mʌtʃ/', pos: 'det.', translation: '许多' },
    more: { phonetic: '/mɔːr/', pos: 'adv.', translation: '更多/更' },
    less: { phonetic: '/les/', pos: 'adv.', translation: '更少/更' },
    very: { phonetic: '/ˈveri/', pos: 'adv.', translation: '非常' },
    too: { phonetic: '/tuː/', pos: 'adv.', translation: '太/也' },
    not: { phonetic: '/nɒt/', pos: 'adv.', translation: '不' },
    only: { phonetic: '/ˈoʊnli/', pos: 'adv.', translation: '只有/仅仅' },
    also: { phonetic: '/ˈɔːlsoʊ/', pos: 'adv.', translation: '也' },
    then: { phonetic: '/ðen/', pos: 'adv.', translation: '然后/那时' },
    there: { phonetic: '/ðer/', pos: 'adv.', translation: '那里' },
    here: { phonetic: '/hɪr/', pos: 'adv.', translation: '这里' },
    away: { phonetic: '/əˈweɪ/', pos: 'adv.', translation: '离开/远离' },
    once: { phonetic: '/wʌns/', pos: 'adv.', translation: '一次/同时' }
};

function normalizeKey(text = '') {
    return String(text || '')
        .toLowerCase()
        .replace(/[’]/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenizeText(text = '') {
    const tokens = [];
    for (const match of String(text || '').matchAll(WORD_REGEX)) {
        tokens.push({
            text: match[0],
            lower: normalizeKey(match[0]),
            index: match.index || 0
        });
    }
    return tokens;
}

function wordTypeToPos(wordType = 'other', contentType = 'word') {
    if (contentType === 'phrase' || contentType === 'sentence') return 'phr.';
    const type = String(wordType || 'other').toLowerCase();
    if (type === 'noun') return 'n.';
    if (type === 'verb') return 'v.';
    if (type === 'adj') return 'adj.';
    if (type === 'adv') return 'adv.';
    if (type === 'prep') return 'prep.';
    if (type === 'conj') return 'conj.';
    if (type === 'pron') return 'pron.';
    return 'other.';
}

function buildMorphCandidates(lower = '') {
    const candidates = new Set([lower]);
    if (IRREGULAR_BASE_MAP[lower]) candidates.add(IRREGULAR_BASE_MAP[lower]);

    if (lower.endsWith('ies') && lower.length > 4) candidates.add(`${lower.slice(0, -3)}y`);
    if (lower.endsWith('es') && lower.length > 3) candidates.add(lower.slice(0, -2));
    if (lower.endsWith('s') && lower.length > 3) candidates.add(lower.slice(0, -1));

    if (lower.endsWith('ing') && lower.length > 5) {
        candidates.add(lower.slice(0, -3));
        candidates.add(`${lower.slice(0, -3)}e`);
        if (/(.)\1$/.test(lower.slice(0, -3))) candidates.add(lower.slice(0, -4));
    }
    if (lower.endsWith('ed') && lower.length > 4) {
        candidates.add(lower.slice(0, -2));
        candidates.add(`${lower.slice(0, -2)}e`);
        if (/(.)\1$/.test(lower.slice(0, -2))) candidates.add(lower.slice(0, -3));
    }
    return Array.from(candidates).filter(Boolean);
}

function chooseBetterEntry(current, next) {
    if (!current) return next;
    const score = (entry) => {
        let val = 0;
        if (entry.phonetic) val += 2;
        if (entry.translation) val += 2;
        if (entry.audio_url_female || entry.audio_url_male) val += 1;
        if (entry.content_type === 'phrase') val += 1;
        return val;
    };
    return score(next) > score(current) ? next : current;
}

function buildLookupMaps(wordRows = []) {
    const wordMap = new Map();
    const phraseMap = new Map();
    let maxPhraseLength = 1;

    for (const row of wordRows) {
        const key = normalizeKey(row.word);
        if (!key) continue;
        const tokenLength = key.split(' ').length;
        if (tokenLength > 1 || row.content_type === 'phrase' || row.content_type === 'sentence') {
            phraseMap.set(key, chooseBetterEntry(phraseMap.get(key), row));
            maxPhraseLength = Math.max(maxPhraseLength, tokenLength);
        } else {
            wordMap.set(key, chooseBetterEntry(wordMap.get(key), row));
        }
    }

    return { wordMap, phraseMap, maxPhraseLength };
}

function makeEntryFromRow(displayWord, row) {
    return {
        word: displayWord,
        phonetic: row.phonetic || '',
        pos: wordTypeToPos(row.word_type, row.content_type),
        translation: row.translation || '',
        audio_url: row.audio_url_female || row.audio_url_male || null
    };
}

function makeFallbackEntry(displayWord) {
    const fallback = FALLBACK_ENTRIES[normalizeKey(displayWord)];
    if (!fallback) return null;
    return {
        word: displayWord,
        phonetic: fallback.phonetic || '',
        pos: fallback.pos || 'other.',
        translation: fallback.translation || '',
        audio_url: null
    };
}

function analyzePictureBookText(text, lookup) {
    const tokens = tokenizeText(text);
    const results = [];
    const consumed = new Array(tokens.length).fill(false);

    for (let i = 0; i < tokens.length; i++) {
        if (consumed[i]) continue;

        let matched = false;
        const maxLen = Math.min(lookup.maxPhraseLength, tokens.length - i);
        for (let len = maxLen; len >= 2; len--) {
            if (consumed.slice(i, i + len).some(Boolean)) continue;
            const phraseKey = tokens.slice(i, i + len).map(t => t.lower).join(' ');
            const row = lookup.phraseMap.get(phraseKey);
            if (!row) continue;

            const displayWord = tokens.slice(i, i + len).map(t => t.text).join(' ');
            results.push(makeEntryFromRow(displayWord, row));
            consumed.fill(true, i, i + len);
            matched = true;
            break;
        }
        if (matched) continue;

        const token = tokens[i];
        let row = lookup.wordMap.get(token.lower);
        if (!row) {
            const morphCandidates = buildMorphCandidates(token.lower);
            for (const candidate of morphCandidates) {
                row = lookup.wordMap.get(candidate);
                if (row) break;
            }
        }

        if (row) {
            results.push(makeEntryFromRow(token.text, row));
            consumed[i] = true;
            continue;
        }

        const fallback = makeFallbackEntry(token.text);
        if (fallback) {
            results.push(fallback);
            consumed[i] = true;
            continue;
        }

        results.push({
            word: token.text,
            phonetic: '',
            pos: /^[A-Z]/.test(token.text) ? 'n.' : 'other.',
            translation: /^[A-Z]/.test(token.text) ? `${token.text}（专有名词）` : '',
            audio_url: null
        });
        consumed[i] = true;
    }

    return results;
}

module.exports = {
    buildLookupMaps,
    analyzePictureBookText,
    normalizeKey,
    tokenizeText
};
