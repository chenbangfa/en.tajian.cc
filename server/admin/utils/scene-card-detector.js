const fs = require('fs');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const vertexAuth = require('../../src/utils/vertex-auth');

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function getMimeTypeFromPath(filePath) {
    const ext = path.extname(filePath || '').toLowerCase();
    const table = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.webp': 'image/webp',
        '.gif': 'image/gif'
    };
    return table[ext] || 'image/jpeg';
}

function normalizeGeminiBoxCoordinate(value, maxAbs) {
    const n = Number(value) || 0;
    // Gemini 偶尔会返回 0-1 小数坐标；主提示词要求 0-1000，这里兼容两种格式。
    return maxAbs <= 1.5 ? n : n / 1000;
}

function stripMarkdownJsonFence(rawText = '') {
    return String(rawText || '')
        .replace(/```json\n?/gi, '')
        .replace(/```\n?/g, '')
        .trim();
}

function extractJsonArrayText(rawText = '') {
    const cleaned = stripMarkdownJsonFence(rawText);
    const first = cleaned.indexOf('[');
    const last = cleaned.lastIndexOf(']');
    if (first < 0 || last <= first) return cleaned;
    return cleaned.slice(first, last + 1);
}

function parseGeminiJsonArray(rawText = '') {
    const source = extractJsonArrayText(rawText);
    const attempts = [
        source,
        source
            .replace(/[“”]/g, '"')
            .replace(/[‘’]/g, "'")
            .replace(/,\s*([}\]])/g, '$1')
            .replace(/}\s*{/g, '},{')
            .replace(/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)(?=\s*[\],])/g, '$1, $2')
    ];

    let lastError;
    for (const candidate of attempts) {
        try {
            return JSON.parse(candidate);
        } catch (error) {
            lastError = error;
        }
    }
    const err = new Error(lastError?.message || 'Gemini 未返回有效 JSON');
    err.rawText = String(rawText || '').slice(0, 1000);
    throw err;
}

function smoothCounts(values, radius) {
    if (!values.length || radius <= 0) return values.slice();
    const prefix = new Array(values.length + 1).fill(0);
    for (let i = 0; i < values.length; i++) {
        prefix[i + 1] = prefix[i] + values[i];
    }
    return values.map((_, i) => {
        const start = Math.max(0, i - radius);
        const end = Math.min(values.length - 1, i + radius);
        const sum = prefix[end + 1] - prefix[start];
        return sum / (end - start + 1);
    });
}

function extractBands(values, threshold, minLength = 1) {
    const bands = [];
    let start = -1;

    for (let i = 0; i < values.length; i++) {
        if (values[i] >= threshold) {
            if (start === -1) start = i;
        } else if (start !== -1) {
            if (i - start >= minLength) {
                bands.push({ start, end: i - 1 });
            }
            start = -1;
        }
    }

    if (start !== -1 && values.length - start >= minLength) {
        bands.push({ start, end: values.length - 1 });
    }

    return bands.map((band) => ({
        ...band,
        length: band.end - band.start + 1,
        center: (band.start + band.end) / 2,
        score: values.slice(band.start, band.end + 1).reduce((sum, current) => sum + current, 0)
    }));
}

function mergeBands(bands, gapTolerance = 0) {
    if (bands.length <= 1) return bands.slice();
    const merged = [bands[0]];
    for (let i = 1; i < bands.length; i++) {
        const prev = merged[merged.length - 1];
        const current = bands[i];
        if (current.start - prev.end - 1 <= gapTolerance) {
            prev.end = current.end;
            prev.length = prev.end - prev.start + 1;
            prev.center = (prev.start + prev.end) / 2;
            prev.score += current.score;
        } else {
            merged.push({ ...current });
        }
    }
    return merged;
}

function pickExpectedBands(bands, expectedCount, fallbackStart, fallbackEnd) {
    if (expectedCount <= 0) return [];
    if (!bands.length) {
        return splitRangeEvenly(fallbackStart, fallbackEnd, expectedCount);
    }

    let working = bands.slice().sort((a, b) => a.start - b.start);
    if (working.length > expectedCount) {
        working = working
            .slice()
            .sort((a, b) => b.score - a.score)
            .slice(0, expectedCount)
            .sort((a, b) => a.start - b.start);
    }

    if (working.length < expectedCount) {
        return splitRangeEvenly(fallbackStart, fallbackEnd, expectedCount);
    }

    return working;
}

function splitRangeEvenly(start, end, count) {
    const bands = [];
    const total = Math.max(1, end - start + 1);
    const size = total / count;
    for (let i = 0; i < count; i++) {
        const bandStart = Math.round(start + i * size);
        const bandEnd = Math.round(start + (i + 1) * size) - 1;
        bands.push({
            start: bandStart,
            end: i === count - 1 ? end : bandEnd,
            length: (i === count - 1 ? end : bandEnd) - bandStart + 1,
            center: (bandStart + (i === count - 1 ? end : bandEnd)) / 2,
            score: 0
        });
    }
    return bands;
}

/**
 * 在 [start, end] 区间内寻找 N-1 条切分线，使得每条线落在"谷底"（投影值最低处），
 * 用于把相邻卡片之间的间隙准确分开。
 *
 * 算法：把 [start, end] 平均分成 count 段作为"候选中心"，在每两段中心之间
 * 取相邻 1/3 的搜索窗口，选择该窗口内投影值最小的位置作为切分线。
 */
function findValleyCuts(values, start, end, count, {
    searchFraction = 0.33,
    minGap = 2
} = {}) {
    if (count <= 1) return [];
    const span = end - start;
    if (span <= 0) return [];
    const segment = span / count;
    const cuts = [];

    for (let i = 1; i < count; i++) {
        const centerPrev = start + (i - 1 + 0.5) * segment;
        const centerNext = start + (i + 0.5) * segment;
        const defaultCut = Math.round(start + i * segment);
        const half = Math.max(minGap, Math.floor((centerNext - centerPrev) * searchFraction / 2));
        const winStart = Math.max(start + 1, defaultCut - half);
        const winEnd = Math.min(end - 1, defaultCut + half);

        let bestIdx = defaultCut;
        let bestVal = Infinity;
        for (let j = winStart; j <= winEnd; j++) {
            const v = values[j];
            if (v < bestVal) {
                bestVal = v;
                bestIdx = j;
            }
        }
        cuts.push(bestIdx);
    }

    return cuts;
}

/**
 * 根据切分线数组生成 bands（每段对应一张卡片的范围）。
 */
function bandsFromCuts(start, end, cuts) {
    const points = [start, ...cuts, end];
    const bands = [];
    for (let i = 0; i < points.length - 1; i++) {
        const bandStart = Math.max(start, Math.min(end, points[i] + (i === 0 ? 0 : 1)));
        const bandEnd = Math.max(bandStart, Math.min(end, points[i + 1]));
        bands.push({
            start: bandStart,
            end: bandEnd,
            length: bandEnd - bandStart + 1,
            center: (bandStart + bandEnd) / 2,
            score: 0
        });
    }
    return bands;
}

function findSustainedStart(values, threshold, {
    start = 0,
    end = values.length - 1,
    window = 6,
    requiredHits = 5
} = {}) {
    const safeEnd = Math.min(end, values.length - 1);
    for (let i = Math.max(0, start); i <= safeEnd - window + 1; i++) {
        let hitCount = 0;
        for (let offset = 0; offset < window; offset++) {
            if (values[i + offset] >= threshold) hitCount++;
        }
        if (hitCount >= requiredHits) {
            return i;
        }
    }
    return -1;
}

function findSustainedEnd(values, threshold, {
    start = 0,
    end = values.length - 1,
    window = 6,
    requiredHits = 5
} = {}) {
    const safeStart = Math.max(0, start);
    const safeEnd = Math.min(end, values.length - 1);
    for (let i = safeEnd; i >= safeStart + window - 1; i--) {
        let hitCount = 0;
        for (let offset = 0; offset < window; offset++) {
            if (values[i - offset] >= threshold) hitCount++;
        }
        if (hitCount >= requiredHits) {
            return i;
        }
    }
    return -1;
}

async function loadImageBuffer(imageUrl) {
    if (!imageUrl) {
        throw new Error('缺少图片地址');
    }

    if (/^https?:\/\//i.test(imageUrl)) {
        const response = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
            timeout: 15000
        });
        return Buffer.from(response.data);
    }

    const localPath = path.isAbsolute(imageUrl) && fs.existsSync(imageUrl)
        ? imageUrl
        : imageUrl.startsWith('/')
            ? path.join(__dirname, '../../', imageUrl.replace(/^\/+/, ''))
            : imageUrl;

    if (!fs.existsSync(localPath)) {
        throw new Error(`图片不存在: ${localPath}`);
    }

    return fs.readFileSync(localPath);
}

async function loadImageMetadata(imageUrl) {
    const imageBuffer = await loadImageBuffer(imageUrl);
    const metadata = await sharp(imageBuffer).rotate().metadata();
    return { imageBuffer, metadata };
}

function buildCardsFromGridBounds(width, height, {
    expectedColumns,
    expectedRows,
    left,
    right,
    top,
    bottom,
    gapX = 0,
    gapY = 0,
    cardWidthDelta = 0,
    cardHeightDelta = 0
}) {
    const cards = [];
    const gridWidth = Math.max(1, right - left + 1);
    const gridHeight = Math.max(1, bottom - top + 1);
    const safeGapX = clamp(gapX, -gridWidth / Math.max(expectedColumns, 1), gridWidth / Math.max(expectedColumns, 1));
    const safeGapY = clamp(gapY, -gridHeight / Math.max(expectedRows, 1), gridHeight / Math.max(expectedRows, 1));
    const baseCellWidth = (gridWidth - safeGapX * Math.max(expectedColumns - 1, 0)) / expectedColumns;
    const baseCellHeight = (gridHeight - safeGapY * Math.max(expectedRows - 1, 0)) / expectedRows;
    const cardWidth = Math.max(1, baseCellWidth + cardWidthDelta);
    const cardHeight = Math.max(1, baseCellHeight + cardHeightDelta);

    for (let rowIndex = 0; rowIndex < expectedRows; rowIndex++) {
        const rowStart = top + rowIndex * (baseCellHeight + safeGapY);
        const rowCenter = rowStart + baseCellHeight / 2;
        for (let colIndex = 0; colIndex < expectedColumns; colIndex++) {
            const colStart = left + colIndex * (baseCellWidth + safeGapX);
            const colCenter = colStart + baseCellWidth / 2;
            const cellLeft = clamp(Math.round(colCenter - cardWidth / 2), 0, width - 1);
            const cellTop = clamp(Math.round(rowCenter - cardHeight / 2), 0, height - 1);
            const cellRight = clamp(Math.round(colCenter + cardWidth / 2), 0, width - 1);
            const cellBottom = clamp(Math.round(rowCenter + cardHeight / 2), 0, height - 1);

            if (cellRight <= cellLeft || cellBottom <= cellTop) continue;

            cards.push({
                row: rowIndex,
                col: colIndex,
                rect: {
                    x: Number(((cellLeft / width) * 100).toFixed(4)),
                    y: Number(((cellTop / height) * 100).toFixed(4)),
                    w: Number((((cellRight - cellLeft) / width) * 100).toFixed(4)),
                    h: Number((((cellBottom - cellTop) / height) * 100).toFixed(4))
                }
            });
        }
    }

    return cards;
}

async function buildPosterTemplateCards(imageUrl, options = {}) {
    const expectedColumns = Math.max(parseInt(options.expectedColumns, 10) || 4, 1);
    const expectedCount = Math.max(parseInt(options.expectedCount, 10) || 0, 0);
    const expectedRows = Math.max(parseInt(options.expectedRows, 10) || Math.ceil((expectedCount || expectedColumns) / expectedColumns), 1);

    const { metadata } = await loadImageMetadata(imageUrl);
    const width = metadata.width;
    const height = metadata.height;
    if (!width || !height) {
        throw new Error('无法读取图片尺寸');
    }

    const layoutMap = {
        4: {
            leftPct: 1.49,
            rightPct: 98.41,
            topPct: 15.55,
            bottomPct: 99.28
        },
        3: {
            leftPct: 1.81,
            rightPct: 99.89,
            topPct: 17.40,
            bottomPct: 99.94
        }
    };

    const layout = layoutMap[expectedRows] || {
        leftPct: 1.6,
        rightPct: 98.6,
        topPct: 16.2,
        bottomPct: 99.1
    };
    const rawAdjustments = options.layoutAdjustments || {};
    const adjustments = {
        leftPct: Number(rawAdjustments.leftPct || 0),
        rightPct: Number(rawAdjustments.rightPct || 0),
        topPct: Number(rawAdjustments.topPct || 0),
        bottomPct: Number(rawAdjustments.bottomPct || 0),
        cardWidthPct: Number(rawAdjustments.cardWidthPct || 0),
        cardHeightPct: Number(rawAdjustments.cardHeightPct || 0),
        gapXPct: Number(rawAdjustments.gapXPct || 0),
        gapYPct: Number(rawAdjustments.gapYPct || 0)
    };
    const resolvedLayout = {
        leftPct: clamp(layout.leftPct + adjustments.leftPct, 0, 95),
        rightPct: clamp(layout.rightPct + adjustments.rightPct, 5, 100),
        topPct: clamp(layout.topPct + adjustments.topPct, 0, 95),
        bottomPct: clamp(layout.bottomPct + adjustments.bottomPct, 5, 100)
    };

    if (resolvedLayout.rightPct <= resolvedLayout.leftPct + 1) {
        resolvedLayout.rightPct = clamp(resolvedLayout.leftPct + 1, 5, 100);
    }
    if (resolvedLayout.bottomPct <= resolvedLayout.topPct + 1) {
        resolvedLayout.bottomPct = clamp(resolvedLayout.topPct + 1, 5, 100);
    }

    const bounds = {
        expectedColumns,
        expectedRows,
        left: Math.round(width * resolvedLayout.leftPct / 100),
        right: Math.round(width * resolvedLayout.rightPct / 100),
        top: Math.round(height * resolvedLayout.topPct / 100),
        bottom: Math.round(height * resolvedLayout.bottomPct / 100),
        gapX: width * clamp(adjustments.gapXPct, -10, 10) / 100,
        gapY: height * clamp(adjustments.gapYPct, -10, 10) / 100,
        cardWidthDelta: width * clamp(adjustments.cardWidthPct, -20, 20) / 100,
        cardHeightDelta: height * clamp(adjustments.cardHeightPct, -20, 20) / 100
    };

    return {
        width,
        height,
        expectedColumns,
        expectedRows,
        engine: 'poster_template',
        cards: buildCardsFromGridBounds(width, height, bounds),
        debug: options.debug ? {
            mode: 'poster_template',
            layout,
            resolvedLayout,
            adjustments,
            ...bounds
        } : undefined
    };
}

async function detectSceneCards(imageUrl, options = {}) {
    const expectedColumns = Math.max(parseInt(options.expectedColumns, 10) || 4, 1);
    const expectedCount = Math.max(parseInt(options.expectedCount, 10) || 0, 0);
    const expectedRows = Math.max(parseInt(options.expectedRows, 10) || Math.ceil((expectedCount || expectedColumns) / expectedColumns), 1);

    const imageBuffer = await loadImageBuffer(imageUrl);
    const base = sharp(imageBuffer).rotate().flatten({ background: '#ffffff' });
    const metadata = await base.metadata();

    const targetWidth = metadata.width && metadata.width > 1200 ? 1200 : metadata.width;
    const resized = targetWidth && targetWidth !== metadata.width
        ? base.resize({ width: targetWidth, withoutEnlargement: true })
        : base;

    const { data, info } = await resized
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    const { width, height, channels } = info;
    const topIgnore = Math.floor(height * 0.08);
    const mask = new Uint8Array(width * height);
    const strongMask = new Uint8Array(width * height);
    const softMask = new Uint8Array(width * height);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * channels;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];
            const gray = (r + g + b) / 3;
            const max = Math.max(r, g, b);
            const min = Math.min(r, g, b);
            const saturation = max - min;
            const contrast = Math.abs(r - g) + Math.abs(g - b) + Math.abs(r - b);
            const whiteDistance = (255 - r) + (255 - g) + (255 - b);
            const isSoftForeground = whiteDistance > 6 || saturation > 8 || contrast > 12;
            const isForeground = gray < 245 || saturation > 16 || contrast > 24;
            const isStrongForeground = gray < 235 || saturation > 24 || contrast > 34;
            if (isSoftForeground) {
                softMask[y * width + x] = 1;
            }
            if (isForeground) {
                mask[y * width + x] = 1;
            }
            if (isStrongForeground) {
                strongMask[y * width + x] = 1;
            }
        }
    }

    const rowCounts = new Array(height).fill(0);
    for (let y = 0; y < height; y++) {
        let rowSum = 0;
        for (let x = 0; x < width; x++) {
            rowSum += mask[y * width + x];
        }
        rowCounts[y] = rowSum;
    }

    const smoothedRows = smoothCounts(rowCounts, Math.max(8, Math.round(height * 0.02)));
    const rowThreshold = Math.max(Math.max(...smoothedRows) * 0.08, width * 0.01);
    const allRowBands = mergeBands(
        extractBands(smoothedRows, rowThreshold, Math.max(8, Math.round(height * 0.018))),
        Math.max(8, Math.round(height * 0.018))
    );

    const titleBand = allRowBands.find((band) => band.center < height * 0.28) || {
        start: 0,
        end: Math.floor(height * 0.14)
    };
    const scanStart = clamp(titleBand.end + Math.round(height * 0.005), topIgnore, height - 1);

    const softRowCounts = new Array(height).fill(0);
    for (let y = 0; y < height; y++) {
        let rowSum = 0;
        for (let x = 0; x < width; x++) {
            rowSum += softMask[y * width + x];
        }
        softRowCounts[y] = rowSum;
    }

    const postTitleSoftRows = softRowCounts.slice(scanStart);
    const postTitleSoftMax = postTitleSoftRows.length ? Math.max(...postTitleSoftRows) : 0;
    const gridStartThreshold = Math.max(width * 0.03, postTitleSoftMax * 0.06);
    const gridTopCandidate = findSustainedStart(softRowCounts, gridStartThreshold, {
        start: scanStart,
        end: height - 1,
        window: 6,
        requiredHits: 5
    });

    const gridBand = {
        start: gridTopCandidate >= 0 ? gridTopCandidate : Math.floor(height * 0.18),
        end: Math.floor(height * 0.96)
    };

    let minX = width - 1;
    let minY = height - 1;
    let maxX = 0;
    let maxY = 0;
    let found = false;

    for (let y = scanStart; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (!strongMask[y * width + x]) continue;
            found = true;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
    }

    let gridTop = gridTopCandidate >= 0 ? gridTopCandidate : Math.floor(height * 0.18);
    let gridBottom = Math.floor(height * 0.96);
    let contentLeft = Math.floor(width * 0.05);
    let contentRight = Math.floor(width * 0.95);

    const softColCounts = new Array(width).fill(0);
    for (let x = 0; x < width; x++) {
        let colSum = 0;
        for (let y = gridTop; y < height; y++) {
            colSum += softMask[y * width + x];
        }
        softColCounts[x] = colSum;
    }

    const softColMax = softColCounts.length ? Math.max(...softColCounts) : 0;
    const colThreshold = Math.max((height - gridTop) * 0.04, softColMax * 0.10);
    const contentLeftCandidate = findSustainedStart(softColCounts, colThreshold, {
        start: 0,
        end: width - 1,
        window: 6,
        requiredHits: 5
    });
    const contentRightCandidate = findSustainedEnd(softColCounts, colThreshold, {
        start: 0,
        end: width - 1,
        window: 6,
        requiredHits: 5
    });

    if (contentLeftCandidate >= 0) contentLeft = contentLeftCandidate;
    if (contentRightCandidate >= 0) contentRight = contentRightCandidate;

    const contentRowCounts = new Array(height).fill(0);
    for (let y = gridTop; y < height; y++) {
        let rowSum = 0;
        for (let x = contentLeft; x <= contentRight; x++) {
            rowSum += softMask[y * width + x];
        }
        contentRowCounts[y] = rowSum;
    }

    const contentRowMax = contentRowCounts.length ? Math.max(...contentRowCounts) : 0;
    const bottomThreshold = Math.max((contentRight - contentLeft + 1) * 0.04, contentRowMax * 0.10);
    const gridBottomCandidate = findSustainedEnd(contentRowCounts, bottomThreshold, {
        start: gridTop,
        end: height - 1,
        window: 6,
        requiredHits: 5
    });
    if (gridBottomCandidate >= 0) {
        gridBottom = gridBottomCandidate;
    }

    // === 按"谷底"切行：在 grid 区域内对软前景做行投影，在其中找 expectedRows-1 个谷底作为行分割线 ===
    const rowProfile = new Array(height).fill(0);
    for (let y = gridTop; y <= gridBottom; y++) {
        let rowSum = 0;
        for (let x = contentLeft; x <= contentRight; x++) {
            rowSum += softMask[y * width + x];
        }
        rowProfile[y] = rowSum;
    }
    const smoothedRowProfile = smoothCounts(rowProfile, Math.max(3, Math.round(height * 0.006)));
    const rowCuts = findValleyCuts(smoothedRowProfile, gridTop, gridBottom, expectedRows);
    const rowBands = bandsFromCuts(gridTop, gridBottom, rowCuts);

    // === 每一行内独立按"谷底"切列 ===
    // 由于每行内列宽可能不同，按行计算列投影再切分，效果好于用全局列投影
    const rowColBands = rowBands.map((row) => {
        const colProfile = new Array(width).fill(0);
        for (let x = contentLeft; x <= contentRight; x++) {
            let colSum = 0;
            for (let y = row.start; y <= row.end; y++) {
                colSum += softMask[y * width + x];
            }
            colProfile[x] = colSum;
        }
        const smoothedColProfile = smoothCounts(colProfile, Math.max(3, Math.round(width * 0.006)));
        const colCuts = findValleyCuts(smoothedColProfile, contentLeft, contentRight, expectedColumns);
        return bandsFromCuts(contentLeft, contentRight, colCuts);
    });

    const cards = [];
    for (let rowIndex = 0; rowIndex < rowBands.length; rowIndex++) {
        const row = rowBands[rowIndex];
        const colBands = rowColBands[rowIndex];
        for (let colIndex = 0; colIndex < colBands.length; colIndex++) {
            const col = colBands[colIndex];
            const left = clamp(col.start, 0, width - 1);
            const top = clamp(row.start, 0, height - 1);
            const right = clamp(col.end, 0, width - 1);
            const bottom = clamp(row.end, 0, height - 1);

            if (right <= left || bottom <= top) continue;

            cards.push({
                row: rowIndex,
                col: colIndex,
                rect: {
                    x: Number(((left / width) * 100).toFixed(4)),
                    y: Number(((top / height) * 100).toFixed(4)),
                    w: Number((((right - left) / width) * 100).toFixed(4)),
                    h: Number((((bottom - top) / height) * 100).toFixed(4))
                }
            });
        }
    }

    return {
        width,
        height,
        expectedColumns,
        expectedRows,
        cards,
        debug: options.debug ? {
            mode: 'projection-valley',
            allRowBands,
            titleBand,
            gridBand,
            scanStart,
            gridTopCandidate,
            gridStartThreshold,
            rowBands,
            rowColBands,
            gridTop,
            gridBottom,
            contentLeft,
            contentRight
        } : undefined
    };
}

/**
 * 使用 Gemini Vision 识别每张卡片的 bbox。
 * CN 服务器连不上 vertex，所以优先走 PROXY_BASE_URL/proxy/detect-cards；
 * 未配置代理时（US 环境）再回落到直连 vertexAuth。
 * 返回 { width, height, cards: [{row, col, rect:{x,y,w,h} (百分比)}] }
 */
async function detectCardsWithVision(imageUrl, options = {}) {
    const useProxy = !!process.env.PROXY_BASE_URL;
    if (!useProxy && !vertexAuth.isConfigured) {
        throw new Error('Gemini Vision 未配置');
    }

    const expectedColumns = Math.max(parseInt(options.expectedColumns, 10) || 4, 1);
    const expectedCount = Math.max(parseInt(options.expectedCount, 10) || 0, 0);
    const expectedRows = Math.max(
        parseInt(options.expectedRows, 10)
            || Math.ceil((expectedCount || expectedColumns) / expectedColumns),
        1
    );

    const { imageBuffer, metadata } = await loadImageMetadata(imageUrl);
    const width = metadata.width;
    const height = metadata.height;
    if (!width || !height) {
        throw new Error('无法读取图片尺寸');
    }

    // 为降低 token 与国际传输量，长边超过 1280px 的图先缩到 1280px 再发
    // （bbox 用归一化坐标，缩放不影响结果）
    const longEdge = Math.max(width, height);
    let sendBuffer = imageBuffer;
    let sendMime = metadata.format ? `image/${metadata.format === 'jpeg' ? 'jpeg' : metadata.format}` : getMimeTypeFromPath(imageUrl);
    if (longEdge > 1280) {
        sendBuffer = await sharp(imageBuffer)
            .rotate()
            .resize({
                width: width >= height ? 1280 : undefined,
                height: height > width ? 1280 : undefined,
                withoutEnlargement: true
            })
            .jpeg({ quality: 85 })
            .toBuffer();
        sendMime = 'image/jpeg';
    }
    const base64Image = sendBuffer.toString('base64');

    let cards;
    let rawCount;

    if (useProxy) {
        // 经 US 代理服务器转发到 Gemini（CN 线路无法直连 vertex）
        const proxyBase = String(process.env.PROXY_BASE_URL).replace(/\/+$/, '');
        const response = await axios.post(
            `${proxyBase}/proxy/detect-cards`,
            {
                imageData: base64Image,
                mimeType: sendMime,
                expectedColumns,
                expectedCount,
                expectedRows
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Proxy-Key': process.env.PROXY_API_KEY || ''
                },
                timeout: 90000,
                maxBodyLength: 25 * 1024 * 1024
            }
        );
        const body = response.data || {};
        if (!body.success || !Array.isArray(body.cards)) {
            throw new Error(body.error || '代理返回数据异常');
        }
        cards = body.cards;
        rawCount = body.rawCount;
    } else {
        // 直连 Vertex（仅在 US 部署时可达）
        const expectedDesc = expectedCount > 0
            ? `图中大约有 ${expectedCount} 张卡片，按 ${expectedColumns} 列 × ${expectedRows} 行的网格排布。`
            : `图中卡片大约按 ${expectedColumns} 列排布。`;
        const prompt = `你在分析一张英语学习信息图海报。请识别图中"每一张独立的词汇卡片"的矩形边界框（只要是一张卡片就输出一条，不要合并成整块网格，也不要把标题、背景、装饰当作卡片）。

${expectedDesc}
请只输出一个 JSON 数组，不要 markdown、注释、说明文字，也不要输出示例值。
数组中每个元素必须是对象，只允许包含这三个字段：
- row: 整数，从 0 开始，从上到下递增
- col: 整数，从 0 开始，从左到右递增
- box: 长度为 4 的数字数组，顺序为 [ymin, xmin, ymax, xmax]

要求：
1. box 的四个数字使用 0-1000 的整数归一化坐标（相对于整张图片的高/宽），顺序严格为 [ymin, xmin, ymax, xmax]。
2. row 从 0 开始从上到下递增；col 从 0 开始从左到右递增；按 row 升序、再 col 升序排列。
3. 每张卡片的 bbox 要紧贴卡片外边框（包含卡片的圆角边框，但不要把卡片之间的间隙也框进去）。
4. 如果卡片之间列宽、行高本身不一致，请按实际位置返回，不要强行对齐。
5. 不要返回标题、背景、装饰元素，只返回卡片本身。
6. 必须输出完整、可 JSON.parse 的数组；所有对象和数字之间必须有英文逗号。`;

        const headers = await vertexAuth.getAuthHeaders();
        const response = await axios.post(
            vertexAuth.getUrl('gemini-2.5-flash'),
            {
                contents: [{
                    role: 'user',
                    parts: [
                        { text: prompt },
                        { inline_data: { mime_type: sendMime, data: base64Image } }
                    ]
                }],
                generationConfig: {
                    temperature: 0,
                    responseMimeType: 'application/json',
                    maxOutputTokens: 8192
                }
            },
            { headers, timeout: 60000 }
        );
        const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const parsed = parseGeminiJsonArray(text);
        if (!Array.isArray(parsed) || !parsed.length) {
            throw new Error('Gemini 未识别到任何卡片');
        }
        rawCount = parsed.length;
        cards = parsed
            .map((item) => {
                const box = item.box || item.bbox || [];
                const [ymin, xmin, ymax, xmax] = box.map((n) => Number(n) || 0);
                if (xmax <= xmin || ymax <= ymin) return null;
                const maxAbs = Math.max(Math.abs(ymin), Math.abs(xmin), Math.abs(ymax), Math.abs(xmax));
                const nxMin = normalizeGeminiBoxCoordinate(xmin, maxAbs);
                const nyMin = normalizeGeminiBoxCoordinate(ymin, maxAbs);
                const nxMax = normalizeGeminiBoxCoordinate(xmax, maxAbs);
                const nyMax = normalizeGeminiBoxCoordinate(ymax, maxAbs);
                const cx = clamp(nxMin, 0, 1);
                const cy = clamp(nyMin, 0, 1);
                const cw = clamp(nxMax - nxMin, 0, 1 - cx);
                const ch = clamp(nyMax - nyMin, 0, 1 - cy);
                return {
                    row: Number.isFinite(Number(item.row)) ? parseInt(item.row, 10) : 0,
                    col: Number.isFinite(Number(item.col)) ? parseInt(item.col, 10) : 0,
                    rect: {
                        x: Number((cx * 100).toFixed(4)),
                        y: Number((cy * 100).toFixed(4)),
                        w: Number((cw * 100).toFixed(4)),
                        h: Number((ch * 100).toFixed(4))
                    }
                };
            })
            .filter(Boolean);
        cards.sort((a, b) => {
            const ay = a.rect.y + a.rect.h / 2;
            const by = b.rect.y + b.rect.h / 2;
            const rowGap = Math.max(a.rect.h, b.rect.h) * 0.5;
            if (Math.abs(ay - by) > rowGap) return ay - by;
            return (a.rect.x + a.rect.w / 2) - (b.rect.x + b.rect.w / 2);
        });
    }

    if (expectedCount > 0 && cards.length < expectedCount) {
        const err = new Error(`Gemini 仅识别到 ${cards.length} 张卡片，期望 ${expectedCount} 张`);
        err.partialCards = cards;
        throw err;
    }

    return {
        width,
        height,
        expectedColumns,
        expectedRows,
        engine: useProxy ? 'gemini-vision-proxy' : 'gemini-vision',
        cards: expectedCount > 0 ? cards.slice(0, expectedCount) : cards,
        debug: options.debug ? { mode: useProxy ? 'vision-proxy' : 'vision', rawCount } : undefined
    };
}

module.exports = {
    detectSceneCards,
    detectCardsWithVision,
    buildPosterTemplateCards
};
