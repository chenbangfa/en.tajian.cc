const STYLE_BASE = 'Children picture book illustration, vertical 9:16 composition, warm natural light, clean scene, expressive kid-friendly characters, educational storytelling, no text, no letters, no watermark.';

function normalizeComparableText(value = '') {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripChinese(value = '') {
    return String(value || '').replace(/[\u4e00-\u9fff]/g, ' ');
}

function toEnglishPromptText(value = '') {
    return normalizeComparableText(
        stripChinese(String(value || ''))
            .replace(/[“”]/g, '"')
            .replace(/[‘’]/g, "'")
            .replace(/[^\x20-\x7E\n]/g, ' ')
    );
}

function firstEnglish(...candidates) {
    for (const candidate of candidates) {
        const text = toEnglishPromptText(candidate);
        if (text && /[A-Za-z0-9]/.test(text)) return text;
    }
    return '';
}

function escapeRegExp(str = '') {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePromptBookTitleToEnglish(prompt = '', title = '', titleEn = '') {
    const text = String(prompt || '');
    const en = String(titleEn || '').trim();
    const zh = String(title || '').trim();
    if (!text || !en) return text;

    let out = text;
    out = out.replace(/for\s+book\s+"[^"]*"/ig, `for book "${en}"`);
    out = out.replace(/titled\s+"[^"]*"/ig, `titled "${en}"`);

    if (zh) {
        const zhEsc = escapeRegExp(zh);
        out = out.replace(new RegExp(`"${zhEsc}"\\s*\\([^)]*\\)`, 'g'), `"${en}"`);
        out = out.replace(new RegExp(`"${zhEsc}"`, 'g'), `"${en}"`);
        out = out.replace(new RegExp(`\\(${zhEsc}\\)`, 'g'), `(${en})`);
    }

    return out;
}

function sanitizePictureBookImagePromptForGeneration(prompt = '', options = {}) {
    const { aggressive = false } = options || {};
    let out = String(prompt || '');
    if (!out) return out;

    const replacements = [
        {
            pattern: /Children'?s easy reader picture book cover/ig,
            value: aggressive ? 'Picture book cover' : 'Beginner-friendly picture book cover'
        },
        {
            pattern: /Children'?s easy reader picture book illustration/ig,
            value: aggressive ? 'Picture book illustration' : 'Beginner-friendly picture book illustration'
        },
        {
            pattern: /Children picture book illustration/ig,
            value: 'Picture book illustration'
        },
        {
            pattern: /for ages?\s*\d+\s*-\s*\d+\.?/ig,
            value: ''
        },
        {
            pattern: /for children ages?\s*\d+\s*-\s*\d+\.?/ig,
            value: aggressive ? '' : 'for young learners.'
        },
        {
            pattern: /for children age\s*\d+\s*-\s*\d+\.?/ig,
            value: ''
        },
        {
            pattern: /\bages?\s*3\s*-\s*4\b/ig,
            value: aggressive ? '' : 'early learners'
        },
        {
            pattern: /\bages?\s*4\s*-\s*5\b/ig,
            value: aggressive ? '' : 'young learners'
        },
        {
            pattern: /\bages?\s*5\s*-\s*6\b/ig,
            value: aggressive ? '' : 'developing readers'
        },
        {
            pattern: /\bchild-friendly\b/ig,
            value: aggressive ? 'clear' : 'friendly'
        },
        {
            pattern: /\bkid-friendly\b/ig,
            value: aggressive ? 'friendly' : 'friendly'
        },
        {
            pattern: /\bbeginner-friendly\b/ig,
            value: aggressive ? 'clear' : 'beginner-friendly'
        },
        {
            pattern: /\byoung learners\b/ig,
            value: aggressive ? 'learners' : 'young learners'
        },
        {
            pattern: /\bearly learners\b/ig,
            value: aggressive ? 'learners' : 'early learners'
        },
        {
            pattern: /\bdeveloping readers\b/ig,
            value: aggressive ? 'learners' : 'developing readers'
        },
        {
            pattern: /\bmain child protagonist\b/ig,
            value: 'main story character'
        },
        {
            pattern: /\bcute little\b/ig,
            value: aggressive ? 'gentle' : 'cute'
        }
    ];

    for (const replacement of replacements) {
        out = out.replace(replacement.pattern, replacement.value);
    }

    if (aggressive) {
        out = out
            .replace(/\bchildren'?s?\b/ig, '')
            .replace(/\bchild\b/ig, 'story')
            .replace(/\bkids?\b/ig, '')
            .replace(/\blearners?\b/ig, '')
            .replace(/\bvisual storytelling\b/ig, 'clear storytelling')
            .replace(/\bcozy family feeling\b/ig, 'warm home feeling')
            .replace(/\bfriendly facial expressions\b/ig, 'warm expressions')
            .replace(/\bextra simple composition\b/ig, 'simple composition');
    }

    out = out
        .replace(/\bfor young learners\.\s*for young learners\./ig, 'for young learners.')
        .replace(/\bpicture book illustration,\s*picture book illustration/ig, 'picture book illustration')
        .replace(/\bclear clear\b/ig, 'clear')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/\s{2,}/g, ' ')
        .replace(/\s+\./g, '.')
        .replace(/\.\s*\./g, '.');

    return normalizeComparableText(out);
}

function buildPictureBookImagePromptFallback(prompt = '') {
    const sanitized = sanitizePictureBookImagePromptForGeneration(prompt, { aggressive: true });
    const goalMatch = sanitized.match(/Illustration goal:\s*(.*)$/i);
    const goalText = normalizeComparableText(goalMatch?.[1] || '');

    const sceneSentences = sanitized
        .split(/(?:Illustration goal:|Page \d+ story text:)/i)[0]
        .split('.')
        .map((item) => normalizeComparableText(item))
        .filter(Boolean)
        .slice(-3);

    const fallbackParts = [
        'Picture book illustration, vertical 9:16, warm natural light, simple clean background, one clear main subject, gentle colors, no text, no letters, no watermark.',
        sceneSentences.join('. '),
        goalText ? `Scene focus: ${goalText}` : ''
    ].filter(Boolean);

    return normalizeComparableText(fallbackParts.join(' '));
}

function buildIllustrationGoal(pageText = '', pageNumber = 1) {
    const lines = [];

    if (pageNumber === 1) {
        lines.push('Introduce the main child protagonist and the central learning topic through a clear discovery moment.');
    } else if (pageNumber >= 9) {
        lines.push('Create a strong closing scene that feels warm, meaningful, and clearly connected to this page.');
    } else {
        lines.push('Show the clearest visible moment from this page in a child-friendly story scene.');
    }

    lines.push('Turn the key action, objects, setting, and cause-and-effect from the story text into something a child can understand at a glance.');

    if (/\b(home|family|parent|mother|father|kitchen|bedroom|living room)\b/i.test(pageText)) {
        lines.push('Keep the setting grounded in a warm everyday family environment.');
    }
    if (/\b(school|classroom|teacher|student|library)\b/i.test(pageText)) {
        lines.push('Use a friendly learning environment if it matches the story text.');
    }
    if (/\b(safe|safety|careful|check|protect|emergency|danger|adult)\b/i.test(pageText)) {
        lines.push('Make the careful checking or safety behavior visually obvious.');
    }
    if (/\b(because|so|therefore|turn|change|flow|grow|travel|move|sort|measure|compare|build|save|protect|learn)\b/i.test(pageText)) {
        lines.push('Make the process or cause-and-effect visually readable without relying on written labels.');
    }

    lines.push('If the page explains an invisible process or abstract idea, show it through child-friendly actions, props, demonstrations, or visual storytelling inside the scene, not through posters or text blocks.');
    lines.push('Avoid infographic layouts unless the page truly requires a diagram-like learning scene.');

    return lines.join(' ');
}

function summarizeCue(text = '', maxLen = 180) {
    const normalized = normalizeComparableText(text);
    if (!normalized) return '';
    if (normalized.length <= maxLen) return normalized;
    return `${normalized.slice(0, maxLen - 3).trim()}...`;
}

function buildCoverSourceText(book = {}, pages = []) {
    const titleEn = firstEnglish(book.title_en, book.title, 'Children Picture Book');
    const categoryEn = firstEnglish(book.category_name_en, book.category_name, 'General Knowledge');
    const descriptionEn = firstEnglish(book.description, categoryEn, 'Children learning story');
    const pageCues = pages
        .map(page => firstEnglish(page.text_en))
        .filter(Boolean)
        .map(text => summarizeCue(text, 220));

    return normalizeComparableText([
        `title:${titleEn}`,
        `category:${categoryEn}`,
        `description:${descriptionEn}`,
        pageCues.join(' || ')
    ].filter(Boolean).join(' ### '));
}

function buildPictureBookCoverPrompt(book = {}, pages = []) {
    const titleEn = firstEnglish(book.title_en, book.title, 'Children Picture Book');
    const categoryEn = firstEnglish(book.category_name_en, book.category_name, 'General Knowledge');
    const descriptionEn = firstEnglish(book.description, categoryEn, 'Children learning story');
    const pageTexts = pages
        .map(page => firstEnglish(page.text_en))
        .filter(Boolean);

    const openingCue = summarizeCue(pageTexts[0] || descriptionEn, 180);
    const learningCue = summarizeCue(pageTexts[1] || pageTexts[2] || descriptionEn, 180);
    const endingCue = summarizeCue(pageTexts[pageTexts.length - 1] || pageTexts[0] || descriptionEn, 180);

    const prompt = [
        STYLE_BASE,
        '',
        `Book title (English): "${titleEn}".`,
        `Category (English): ${categoryEn}.`,
        `Theme summary: ${descriptionEn}.`,
        'Create one strong focal cover scene that represents the whole story for children age 5-10.',
        'Keep a consistent main child protagonist, visual style, color palette, and world design that can continue into the inside pages.',
        '',
        'Story arc cues:',
        `Opening: ${openingCue}`,
        `Learning focus: ${learningCue}`,
        `Ending direction: ${endingCue}`,
        '',
        'Cover illustration goal:',
        'Show the most inviting, story-rich, child-friendly moment that communicates the main topic at a glance.',
        'Use one clear central scene instead of a collage. Make the main objects, setting, and emotional tone easy for children to understand.',
        'Do not place any visible title text, letters, labels, infographic panels, or watermark inside the image.'
    ].join('\n');

    return normalizePromptBookTitleToEnglish(prompt, book.title || '', titleEn);
}

function buildPictureBookPagePrompt(book = {}, page = {}) {
    const titleEn = firstEnglish(book.title_en, book.title, 'Children Picture Book');
    const categoryEn = firstEnglish(book.category_name_en, book.category_name, 'General Knowledge');
    const descriptionEn = firstEnglish(book.description, categoryEn, 'Children learning story');
    const pageText = firstEnglish(page.text_en, 'A child-friendly learning moment.');
    const pageNumber = Number(page.page_number) || 1;

    const prompt = [
        STYLE_BASE,
        '',
        `Book title (English): "${titleEn}".`,
        `Category (English): ${categoryEn}.`,
        `Theme summary: ${descriptionEn}.`,
        'Keep a consistent main child protagonist, visual style, color palette, and environment continuity across the whole book.',
        '',
        `Page ${pageNumber} story text:`,
        `"${pageText}"`,
        '',
        'Illustration goal:',
        buildIllustrationGoal(pageText, pageNumber)
    ].join('\n');

    return normalizePromptBookTitleToEnglish(prompt, book.title || '', titleEn);
}

function computeCoverPromptSync(book = {}, pages = []) {
    const prompt = normalizeComparableText(book.cover_prompt || '');
    const sourceText = normalizeComparableText(book.cover_prompt_source_text || '');
    const currentSourceText = buildCoverSourceText(book, pages);

    if (!prompt) {
        return {
            cover_prompt_sync_status: 'missing_prompt',
            cover_prompt_needs_sync: true,
            cover_prompt_source_current: currentSourceText
        };
    }

    if (!sourceText) {
        return {
            cover_prompt_sync_status: 'outdated',
            cover_prompt_needs_sync: true,
            cover_prompt_source_current: currentSourceText
        };
    }

    if (sourceText !== currentSourceText) {
        return {
            cover_prompt_sync_status: 'outdated',
            cover_prompt_needs_sync: true,
            cover_prompt_source_current: currentSourceText
        };
    }

    return {
        cover_prompt_sync_status: 'synced',
        cover_prompt_needs_sync: false,
        cover_prompt_source_current: currentSourceText
    };
}

function computeImagePromptSync(page = {}) {
    const pageText = normalizeComparableText(page.text_en || '');
    const prompt = normalizeComparableText(page.image_prompt || '');
    const sourceText = normalizeComparableText(page.image_prompt_source_text || '');

    if (!pageText) {
        return {
            image_prompt_sync_status: 'missing_text',
            image_prompt_needs_sync: false
        };
    }

    if (!prompt) {
        return {
            image_prompt_sync_status: 'missing_prompt',
            image_prompt_needs_sync: true
        };
    }

    if (!sourceText) {
        return {
            image_prompt_sync_status: 'outdated',
            image_prompt_needs_sync: true
        };
    }

    if (sourceText !== pageText) {
        return {
            image_prompt_sync_status: 'outdated',
            image_prompt_needs_sync: true
        };
    }

    return {
        image_prompt_sync_status: 'synced',
        image_prompt_needs_sync: false
    };
}

async function ensurePictureBookPromptColumns(query) {
    const checks = [
        {
            table: 'picture_books',
            name: 'cover_prompt_source_text',
            sql: `ALTER TABLE picture_books ADD COLUMN cover_prompt_source_text TEXT DEFAULT NULL COMMENT '封面提示词对应的整本内容快照' AFTER cover_prompt`
        },
        {
            table: 'picture_books',
            name: 'cover_prompt_mode',
            sql: `ALTER TABLE picture_books ADD COLUMN cover_prompt_mode VARCHAR(20) DEFAULT 'auto' COMMENT '封面提示词模式 auto/manual' AFTER cover_prompt_source_text`
        },
        {
            name: 'image_prompt',
            sql: `ALTER TABLE picture_book_pages ADD COLUMN image_prompt TEXT DEFAULT NULL COMMENT '页面插图AI提示词' AFTER image_url`
        },
        {
            name: 'image_prompt_source_text',
            sql: `ALTER TABLE picture_book_pages ADD COLUMN image_prompt_source_text TEXT DEFAULT NULL COMMENT '图片提示词对应的英文正文快照' AFTER image_prompt`
        },
        {
            name: 'image_prompt_mode',
            sql: `ALTER TABLE picture_book_pages ADD COLUMN image_prompt_mode VARCHAR(20) DEFAULT 'auto' COMMENT '页面图片提示词模式 auto/manual' AFTER image_prompt_source_text`
        }
    ];

    for (const check of checks) {
        const [row] = await query(
            `SELECT COUNT(*) AS c
             FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = ?
               AND COLUMN_NAME = ?`,
            [check.table || 'picture_book_pages', check.name]
        );
        if (!row?.c) {
            await query(check.sql);
        }
    }
}

module.exports = {
    STYLE_BASE,
    normalizeComparableText,
    normalizePromptBookTitleToEnglish,
    sanitizePictureBookImagePromptForGeneration,
    buildPictureBookImagePromptFallback,
    buildCoverSourceText,
    buildPictureBookCoverPrompt,
    computeCoverPromptSync,
    buildPictureBookPagePrompt,
    computeImagePromptSync,
    ensurePictureBookPromptColumns
};
