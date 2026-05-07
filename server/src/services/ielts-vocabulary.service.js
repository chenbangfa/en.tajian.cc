const { query } = require('../config/database');

function parseJson(value, fallback = {}) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch (_) { return fallback; }
}

function normalizeWordText(value) {
    return String(value || '').trim();
}

function normalizeLookupKey(value) {
    return normalizeWordText(value).toLowerCase();
}

function normalizeVocabularyEntry(entry) {
    if (Array.isArray(entry)) {
        return {
            word_id: entry[4] ? Number(entry[4]) : null,
            word: normalizeWordText(entry[0]),
            translation: normalizeWordText(entry[1]),
            example_sentence: normalizeWordText(entry[2]),
            example_translation: normalizeWordText(entry[3])
        };
    }

    if (typeof entry === 'number') {
        return { word_id: entry, word: '' };
    }

    if (typeof entry === 'string') {
        return { word_id: null, word: normalizeWordText(entry) };
    }

    const raw = entry && typeof entry === 'object' ? entry : {};
    return {
        ...raw,
        word_id: raw.word_id || raw.wordId || raw.id ? Number(raw.word_id || raw.wordId || raw.id) : null,
        word: normalizeWordText(raw.word || raw.text || raw.title),
        translation: normalizeWordText(raw.translation || raw.meaning || raw.cn),
        phonetic: normalizeWordText(raw.phonetic),
        example_sentence: normalizeWordText(raw.example_sentence || raw.example || raw.sentence),
        example_translation: normalizeWordText(raw.example_translation || raw.exampleTranslation || raw.example_cn || raw.exampleCn),
        grammar_explanation: normalizeWordText(raw.grammar_explanation || raw.grammarExplanation || raw.grammar)
    };
}

function getVocabularyEntries(content) {
    const source = Array.isArray(content.words)
        ? content.words
        : (Array.isArray(content.word_refs) ? content.word_refs : []);
    return source.map(normalizeVocabularyEntry).filter(entry => entry.word_id || entry.word);
}

function toPublicWord(row = {}, fallback = {}) {
    return {
        word_id: row.id || fallback.word_id || null,
        word: row.word || fallback.word || '',
        translation: row.translation || fallback.translation || '',
        phonetic: row.phonetic || fallback.phonetic || '',
        example_sentence: row.example_sentence || fallback.example_sentence || '',
        example_translation: row.example_translation || fallback.example_translation || '',
        grammar_explanation: row.grammar_explanation || fallback.grammar_explanation || '',
        audio_url: row.audio_url || fallback.audio_url || '',
        audio_url_female: row.audio_url_female || fallback.audio_url_female || '',
        audio_url_male: row.audio_url_male || fallback.audio_url_male || '',
        translation_audio_url: row.translation_audio_url || fallback.translation_audio_url || '',
        example_audio_female: row.example_audio_female || fallback.example_audio_female || '',
        example_audio_male: row.example_audio_male || fallback.example_audio_male || '',
        example_translation_audio_url: row.example_translation_audio_url || fallback.example_translation_audio_url || '',
        type: 'word'
    };
}

async function findWordsByEntries(entries) {
    const ids = [...new Set(entries.map(entry => Number(entry.word_id)).filter(id => Number.isInteger(id) && id > 0))];
    const words = [...new Set(entries.map(entry => normalizeLookupKey(entry.word)).filter(Boolean))];
    const rows = [];

    if (ids.length) {
        const placeholders = ids.map(() => '?').join(',');
        rows.push(...await query(`SELECT * FROM words WHERE id IN (${placeholders})`, ids));
    }

    if (words.length) {
        const placeholders = words.map(() => '?').join(',');
        rows.push(...await query(`SELECT * FROM words WHERE LOWER(word) IN (${placeholders})`, words));
    }

    const byId = new Map();
    const byWord = new Map();
    rows.forEach(row => {
        if (row.id && !byId.has(Number(row.id))) byId.set(Number(row.id), row);
        const key = normalizeLookupKey(row.word);
        if (key && !byWord.has(key)) byWord.set(key, row);
    });

    return { byId, byWord };
}

async function ensureVocabularyWords(contentJson = {}) {
    const content = parseJson(contentJson, {});
    const entries = getVocabularyEntries(content);
    if (!entries.length) return content;

    const existing = await findWordsByEntries(entries);
    const savedWords = [];

    for (const entry of entries) {
        let row = (entry.word_id && existing.byId.get(Number(entry.word_id))) || existing.byWord.get(normalizeLookupKey(entry.word));

        if (!row && entry.word) {
            const result = await query(`INSERT INTO words
                (word, phonetic, translation, difficulty_level, word_type, display_mode, audio_url,
                 example_sentence, example_translation, grammar_explanation, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`, [
                entry.word,
                entry.phonetic || null,
                entry.translation || '',
                Number(entry.difficulty_level || 1),
                entry.word_type || 'noun',
                entry.display_mode || 'image',
                entry.audio_url || null,
                entry.example_sentence || null,
                entry.example_translation || null,
                entry.grammar_explanation || null
            ]);
            [row] = await query('SELECT * FROM words WHERE id = ?', [result.insertId]);
            if (row) {
                existing.byId.set(Number(row.id), row);
                existing.byWord.set(normalizeLookupKey(row.word), row);
            }
        }

        savedWords.push(toPublicWord(row || {}, entry));
    }

    return {
        ...content,
        words: savedWords,
        word_refs: savedWords.map(word => ({
            word_id: word.word_id,
            word: word.word
        }))
    };
}

async function enrichVocabularyContent(contentJson = {}) {
    const content = parseJson(contentJson, {});
    const entries = getVocabularyEntries(content);
    if (!entries.length) return content;

    const existing = await findWordsByEntries(entries);
    return {
        ...content,
        words: entries.map(entry => {
            const row = (entry.word_id && existing.byId.get(Number(entry.word_id))) || existing.byWord.get(normalizeLookupKey(entry.word));
            return toPublicWord(row || {}, entry);
        })
    };
}

async function enrichVocabularyModule(module = {}) {
    if (!['vocabulary', 'pronunciation'].includes(module.module_type)) return module;
    return {
        ...module,
        content_json: await enrichVocabularyContent(module.content_json || module.content || {})
    };
}

module.exports = {
    ensureVocabularyWords,
    enrichVocabularyContent,
    enrichVocabularyModule,
    normalizeVocabularyEntry
};
