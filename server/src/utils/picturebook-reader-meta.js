const fs = require('fs');
const path = require('path');

function buildBatchFiles(prefix, count) {
    return Array.from({ length: count }, (_, index) =>
        path.resolve(__dirname, `../../../docs/${prefix}${index + 1}-import-data.json`)
    );
}

const V1_BATCH_FILES = buildBatchFiles('picturebook-low-level-easy-readers-batch', 6);
const V2_BATCH_FILES = buildBatchFiles('picturebook-bridge-readers-batch', 6);
const V3_START_BATCH_FILES = buildBatchFiles('picturebook-v3-start-batch', 6);

const V1_THEME_OPTIONS = [
    { id: '', name: '全部主题' },
    { id: 'family', name: '家庭日常' },
    { id: 'habit', name: '身体与习惯' },
    { id: 'food', name: '食物与餐桌' },
    { id: 'nature', name: '自然与天气' },
    { id: 'animal', name: '动物与观察' },
    { id: 'outing', name: '外出与公共场景' }
];

const LEVEL_BY_AGE_GROUP = {
    '3-4': 'L0',
    '4-5': 'L1',
    '5-6': 'L2'
};

const LEVEL_DISPLAY_DIFFICULTY = {
    L0: 1,
    L1: 2,
    L2: 3
};

const STAGE_META = {
    v1: { short_name: 'V1', name: 'V1 启蒙绘本', display_difficulty_level: null },
    v2: { short_name: 'V2', name: 'V2 进阶绘本', display_difficulty_level: 3 },
    v3_start: { short_name: 'V3入门', name: 'V3 主题入门', display_difficulty_level: 4 },
    v3: { short_name: 'V3', name: 'V3 主题阅读', display_difficulty_level: 5 }
};

function inferV1Theme(book) {
    const title = `${book.title || ''} ${book.title_en || ''}`.toLowerCase();
    const category = `${book.category || ''} ${book.category_en || ''}`.toLowerCase();

    if (/(fish|cat|dog|puppy|bird|bunny|rabbit|小鱼|小猫|小狗|小鸟|兔)/.test(title)) {
        return { id: 'animal', name: '动物与观察' };
    }
    if (/(apple|milk|bread|banana|orange|pear|fruit|plate|water|苹果|牛奶|面包|香蕉|橙子|梨|水果|盘|水)/.test(title)) {
        return { id: 'food', name: '食物与餐桌' };
    }
    if (/(rain|wind|moon|sun|snow|flower|seed|tree|cloud|boots|raincoat|下雨|风|月亮|太阳|雪|花|种子|树|云|雨靴|围巾)/.test(title)) {
        return { id: 'nature', name: '自然与天气' };
    }
    if (/(doctor|teeth|tooth|brush|wash|bath|bandage|tissue|light|pajamas|sleep|doctor|洗|牙|医生|纸巾|灯|睡衣|睡觉|围裙|毛巾)/.test(title)) {
        return { id: 'habit', name: '身体与习惯' };
    }
    if (/(bus|slide|class|line|turn|bag|chair|table|park|school|餐桌|排队|轮到|公交|滑梯|教室|书包|椅子|桌子|公园)/.test(title)) {
        return { id: 'outing', name: '外出与公共场景' };
    }
    if (/(健康|急救|身体)/.test(category)) {
        return { id: 'habit', name: '身体与习惯' };
    }
    if (/(营养|食品|食物)/.test(category)) {
        return { id: 'food', name: '食物与餐桌' };
    }
    if (/(自然|生态|户外)/.test(category)) {
        return { id: 'nature', name: '自然与天气' };
    }
    return { id: 'family', name: '家庭日常' };
}

function loadStageBookMap(files, transform) {
    const map = new Map();

    for (const file of files) {
        if (!fs.existsSync(file)) continue;
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw);
        const books = Array.isArray(parsed.books) ? parsed.books : [];

        books.forEach((book) => {
            const meta = transform(book);
            if (book.title) map.set(book.title, meta);
            if (book.title_en) map.set(book.title_en, meta);
        });
    }

    return map;
}

const READER_BOOK_MAP = new Map([
    ...loadStageBookMap(V1_BATCH_FILES, (book) => ({
        reader_stage: 'v1',
        reader_level: book.reader_level || LEVEL_BY_AGE_GROUP[book.age_group] || '',
        display_theme: inferV1Theme(book),
        age_group: book.age_group || ''
    })),
    ...loadStageBookMap(V2_BATCH_FILES, () => ({
        reader_stage: 'v2',
        reader_level: '',
        display_theme: null,
        age_group: ''
    })),
    ...loadStageBookMap(V3_START_BATCH_FILES, () => ({
        reader_stage: 'v3_start',
        reader_level: '',
        display_theme: null,
        age_group: ''
    }))
]);

function decoratePictureBook(row) {
    const readerMeta = READER_BOOK_MAP.get(row.title);
    const stage = readerMeta?.reader_stage || 'v3';
    const stageMeta = STAGE_META[stage] || STAGE_META.v3;
    const readerLevel = readerMeta?.reader_level || '';
    const displayTheme = readerMeta?.display_theme || null;
    const displayDifficultyLevel = stage === 'v1'
        ? (LEVEL_DISPLAY_DIFFICULTY[readerLevel] || row.difficulty_level || 1)
        : (stageMeta.display_difficulty_level || row.difficulty_level || 1);

    return {
        ...row,
        reader_stage: stage,
        reader_stage_name: stageMeta.name,
        reader_stage_short_name: stageMeta.short_name,
        reader_level: readerLevel,
        display_difficulty_level: displayDifficultyLevel,
        age_group: readerMeta?.age_group || row.age_group || '',
        display_theme: displayTheme ? displayTheme.id : '',
        display_theme_name: displayTheme ? displayTheme.name : ''
    };
}

function matchesFilter(book, filters = {}) {
    const {
        categoryId,
        readerStage,
        readerLevel,
        ageGroup,
        displayTheme
    } = filters;

    if (categoryId && Number(book.category_id) !== Number(categoryId)) return false;
    if (readerStage && readerStage !== 'all' && book.reader_stage !== readerStage) return false;
    if (readerLevel && book.reader_level !== readerLevel) return false;
    if (ageGroup && book.age_group !== ageGroup) return false;
    if (displayTheme && book.display_theme !== displayTheme) return false;

    return true;
}

function getV1ThemeOptions() {
    return V1_THEME_OPTIONS;
}

module.exports = {
    decoratePictureBook,
    matchesFilter,
    getV1ThemeOptions
};
