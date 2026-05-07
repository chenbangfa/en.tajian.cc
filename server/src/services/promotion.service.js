const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { query } = require('../config/database');
const config = require('../config');

const MAX_PROFITSHARING_RATE_BPS = 3000;
const PROMOTER_QR_PAGE = process.env.PROMOTER_QR_PAGE || 'pages/index/index';
const WXACODE_DIR = path.join(__dirname, '../../uploads/wxacode');
const WXACODE_URL_PREFIX = '/uploads/wxacode';

let wechatTokenCache = {
    token: '',
    expiresAt: 0
};

function toInt(value, fallback = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.trunc(n);
}

function normalizeRateBps(value, { allowZero = false } = {}) {
    const n = toInt(value, -1);
    if (n < 0 || (!allowZero && n === 0)) {
        throw new Error(allowZero ? '分账比例不能小于 0' : '分账比例必须大于 0');
    }
    if (n > MAX_PROFITSHARING_RATE_BPS) {
        throw new Error('分账比例不能超过 30%');
    }
    return n;
}

function randomCode(size = 10) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.randomBytes(size);
    let code = 'PM';
    for (let i = 0; i < size; i++) {
        code += alphabet[bytes[i] % alphabet.length];
    }
    return code;
}

async function ensureColumn(table, column, definition) {
    const rows = await query(`SHOW COLUMNS FROM ${table} LIKE ?`, [column]);
    if (rows.length) return;
    await query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

async function ensureIndex(table, indexName, columns, { unique = false } = {}) {
    const rows = await query(`SHOW INDEX FROM ${table} WHERE Key_name = ?`, [indexName]);
    if (rows.length) return;
    await query(`ALTER TABLE ${table} ADD ${unique ? 'UNIQUE ' : ''}INDEX ${indexName} (${columns})`);
}

async function ensurePromotionTables() {
    await query(`
        CREATE TABLE IF NOT EXISTS promoters (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL UNIQUE,
            parent_promoter_user_id INT DEFAULT NULL COMMENT '上级推广员，仅二级推广员有值',
            promoter_code VARCHAR(32) NOT NULL UNIQUE COMMENT '推广码',
            role_source ENUM('admin','parent') NOT NULL DEFAULT 'admin',
            status ENUM('active','disabled') NOT NULL DEFAULT 'active',
            commission_rate_bps INT NOT NULL DEFAULT 0 COMMENT '自身分账比例，10000=100%',
            max_child_rate_bps INT NOT NULL DEFAULT 0 COMMENT '可给下级设置的最高比例',
            qr_code_url VARCHAR(500) DEFAULT NULL,
            receiver_status ENUM('missing','pending','added','failed') NOT NULL DEFAULT 'missing',
            total_sales_cent BIGINT NOT NULL DEFAULT 0,
            total_profitsharing_cent BIGINT NOT NULL DEFAULT 0,
            created_by_admin_id INT DEFAULT NULL,
            created_by_promoter_user_id INT DEFAULT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_parent (parent_promoter_user_id),
            INDEX idx_status (status),
            INDEX idx_receiver_status (receiver_status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS promotion_bindings (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL UNIQUE,
            promoter_user_id INT NOT NULL COMMENT '直接归属推广员，可能是一级也可能是二级',
            root_promoter_user_id INT NOT NULL COMMENT '一级推广员',
            promoter_code VARCHAR(32) NOT NULL,
            bind_source ENUM('qrcode','share','manual','system') NOT NULL DEFAULT 'qrcode',
            bound_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            locked TINYINT(1) NOT NULL DEFAULT 1,
            INDEX idx_promoter (promoter_user_id),
            INDEX idx_root (root_promoter_user_id),
            INDEX idx_code (promoter_code)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS profitsharing_receivers (
            id INT AUTO_INCREMENT PRIMARY KEY,
            promoter_user_id INT NOT NULL UNIQUE,
            receiver_type ENUM('PERSONAL_OPENID','MERCHANT_ID') NOT NULL DEFAULT 'PERSONAL_OPENID',
            receiver_account VARCHAR(128) NOT NULL COMMENT '个人openid或商户号',
            receiver_name VARCHAR(128) DEFAULT NULL COMMENT '本地展示用姓名/商户名，敏感信息需脱敏',
            encrypted_name TEXT DEFAULT NULL COMMENT '传给微信的加密姓名/商户名',
            relation_type VARCHAR(32) NOT NULL DEFAULT 'SERVICE_PROVIDER',
            add_status ENUM('pending','added','failed','deleted') NOT NULL DEFAULT 'pending',
            add_error_code VARCHAR(64) DEFAULT NULL,
            add_error_message VARCHAR(255) DEFAULT NULL,
            added_at DATETIME DEFAULT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_status (add_status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Idempotent compatibility for partially-created environments.
    await ensureColumn('promoters', 'qr_code_url', 'VARCHAR(500) DEFAULT NULL');
    await ensureColumn('promoters', 'receiver_status', "ENUM('missing','pending','added','failed') NOT NULL DEFAULT 'missing'");
    await ensureColumn('promoters', 'total_profitsharing_cent', 'BIGINT NOT NULL DEFAULT 0');
    await ensureIndex('promoters', 'idx_receiver_status', 'receiver_status');
}

const tablesReady = ensurePromotionTables();
tablesReady.catch((e) => console.error('[Promotion] 初始化推广表失败:', e));

async function ensureReady() {
    await tablesReady;
}

async function generateUniquePromoterCode() {
    for (let i = 0; i < 8; i++) {
        const code = randomCode(10);
        const rows = await query('SELECT id FROM promoters WHERE promoter_code = ? LIMIT 1', [code]);
        if (!rows.length) return code;
    }
    throw new Error('推广码生成失败，请重试');
}

function normalizePromoterCode(value = '') {
    return String(value || '')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 32);
}

function parsePromoterScene(scene = '') {
    const raw = String(scene || '').trim();
    if (!raw) return '';

    let decoded = raw;
    try {
        decoded = decodeURIComponent(raw);
    } catch (_) {
        decoded = raw;
    }

    if (/^PM[A-Z0-9]{6,}$/i.test(decoded)) {
        return normalizePromoterCode(decoded);
    }

    const pairs = decoded.split('&');
    const params = {};
    pairs.forEach((pair) => {
        const [key, ...rest] = pair.split('=');
        if (!key) return;
        params[key.trim()] = rest.join('=').trim();
    });

    return normalizePromoterCode(
        params.pm ||
        params.p ||
        params.promoter_code ||
        params.promoterCode ||
        params.code ||
        ''
    );
}

function buildPromoterQrScene(promoterCode) {
    const code = normalizePromoterCode(promoterCode);
    if (!code) throw new Error('推广码为空，无法生成二维码');
    return `pm=${code}`;
}

function ensureWxacodeDir() {
    if (!fs.existsSync(WXACODE_DIR)) {
        fs.mkdirSync(WXACODE_DIR, { recursive: true });
    }
}

function localFileExists(relativeUrl = '') {
    if (!relativeUrl) return false;
    if (/^https?:\/\//i.test(relativeUrl)) return true;
    const localPath = path.join(__dirname, '../..', relativeUrl.replace(/^\/+/, ''));
    return fs.existsSync(localPath);
}

async function getWechatAccessToken() {
    if (!config.wechat.appId || !config.wechat.secret) {
        throw new Error('未配置 WECHAT_APPID / WECHAT_SECRET，无法生成推广二维码');
    }

    const now = Date.now();
    if (wechatTokenCache.token && wechatTokenCache.expiresAt > now + 60000) {
        return wechatTokenCache.token;
    }

    const tokenRes = await axios.get('https://api.weixin.qq.com/cgi-bin/token', {
        params: {
            grant_type: 'client_credential',
            appid: config.wechat.appId,
            secret: config.wechat.secret
        },
        timeout: 15000
    });

    if (!tokenRes.data || !tokenRes.data.access_token) {
        throw new Error((tokenRes.data && tokenRes.data.errmsg) || '获取微信 access_token 失败');
    }

    wechatTokenCache = {
        token: tokenRes.data.access_token,
        expiresAt: now + Number(tokenRes.data.expires_in || 7000) * 1000
    };
    return wechatTokenCache.token;
}

async function generatePromoterQrCode(userId, { force = false } = {}) {
    await ensureReady();
    const [promoter] = await query(
        'SELECT user_id, promoter_code, status, qr_code_url FROM promoters WHERE user_id = ? LIMIT 1',
        [userId]
    );
    if (!promoter) throw new Error('推广员不存在');
    if (promoter.status !== 'active') throw new Error('推广员未启用');

    const scene = buildPromoterQrScene(promoter.promoter_code);
    if (!force && promoter.qr_code_url && localFileExists(promoter.qr_code_url)) {
        return {
            url: promoter.qr_code_url,
            scene,
            page: PROMOTER_QR_PAGE,
            cached: true
        };
    }

    ensureWxacodeDir();
    const accessToken = await getWechatAccessToken();
    const wxRes = await axios.post(
        `https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${accessToken}`,
        {
            scene,
            page: PROMOTER_QR_PAGE,
            check_path: false,
            width: 430,
            auto_color: false,
            line_color: { r: 20, g: 138, b: 98 },
            is_hyaline: false
        },
        { responseType: 'arraybuffer', timeout: 20000 }
    );

    const contentType = wxRes.headers['content-type'] || '';
    if (!contentType.includes('image')) {
        let errData = {};
        try {
            errData = JSON.parse(Buffer.from(wxRes.data).toString());
        } catch (_) {
            errData = { errmsg: Buffer.from(wxRes.data).toString().slice(0, 120) };
        }
        throw new Error(errData.errmsg || '生成推广二维码失败');
    }

    const filename = `wxacode_promoter_${promoter.user_id}.png`;
    const savePath = path.join(WXACODE_DIR, filename);
    fs.writeFileSync(savePath, wxRes.data);
    const url = `${WXACODE_URL_PREFIX}/${filename}`;

    await query('UPDATE promoters SET qr_code_url = ? WHERE user_id = ?', [url, promoter.user_id]);
    return {
        url,
        scene,
        page: PROMOTER_QR_PAGE,
        cached: false
    };
}

async function findUser(userId) {
    const [user] = await query(
        'SELECT id, openid, nickname, avatar_url, phone, vip_level, points, created_at FROM users WHERE id = ?',
        [userId]
    );
    return user || null;
}

async function enableRootPromoter({ userId, rateBps, adminId = null }) {
    await ensureReady();
    const normalizedRate = normalizeRateBps(rateBps);
    const user = await findUser(userId);
    if (!user) throw new Error('用户不存在');
    if (!user.openid) throw new Error('用户缺少 OpenID，无法作为个人分账接收方');

    const [existing] = await query('SELECT * FROM promoters WHERE user_id = ? LIMIT 1', [userId]);
    if (existing && existing.parent_promoter_user_id) {
        throw new Error('该用户已是二级推广员，不能直接改为一级推广员');
    }

    if (existing) {
        await query(
            `UPDATE promoters
             SET status = 'active',
                 role_source = 'admin',
                 commission_rate_bps = ?,
                 max_child_rate_bps = ?,
                 created_by_admin_id = COALESCE(created_by_admin_id, ?)
             WHERE user_id = ?`,
            [normalizedRate, normalizedRate, adminId, userId]
        );
    } else {
        const code = await generateUniquePromoterCode();
        await query(
            `INSERT INTO promoters (
                user_id, parent_promoter_user_id, promoter_code, role_source, status,
                commission_rate_bps, max_child_rate_bps, created_by_admin_id
             ) VALUES (?, NULL, ?, 'admin', 'active', ?, ?, ?)`,
            [userId, code, normalizedRate, normalizedRate, adminId]
        );
    }

    await ensurePersonalReceiverFromUser(userId, { addStatus: 'pending' });

    return getPromoterDetail(userId);
}

async function updateRootPromoterRate(userId, rateBps) {
    await ensureReady();
    const normalizedRate = normalizeRateBps(rateBps);
    const [promoter] = await query('SELECT * FROM promoters WHERE user_id = ? LIMIT 1', [userId]);
    if (!promoter) throw new Error('推广员不存在');
    if (promoter.parent_promoter_user_id) throw new Error('二级推广员比例需由上级设置');

    await query(
        'UPDATE promoters SET commission_rate_bps = ?, max_child_rate_bps = ? WHERE user_id = ?',
        [normalizedRate, normalizedRate, userId]
    );
    return getPromoterDetail(userId);
}

async function enableChildPromoterByParent({ parentUserId, childUserId, rateBps }) {
    await ensureReady();
    const normalizedParentUserId = toInt(parentUserId, 0);
    const normalizedChildUserId = toInt(childUserId, 0);
    if (!normalizedParentUserId || !normalizedChildUserId) throw new Error('上级推广员和下级用户不能为空');
    if (normalizedParentUserId === normalizedChildUserId) throw new Error('不能把自己设置为下级推广员');

    const normalizedRate = normalizeRateBps(rateBps);
    const parent = await getPromoterDetail(normalizedParentUserId);
    if (!parent || parent.status !== 'active') throw new Error('当前账号还不是已启用的推广员');
    if (parent.parent_promoter_user_id) throw new Error('二级推广员不能继续设置下级推广员');
    if (normalizedRate > Number(parent.max_child_rate_bps || 0)) {
        throw new Error(`下级佣金比例不能超过 ${formatRatePercent(parent.max_child_rate_bps)}%`);
    }

    const childUser = await findUser(normalizedChildUserId);
    if (!childUser) throw new Error('下级用户不存在');
    if (!childUser.openid) throw new Error('下级用户缺少 OpenID，无法作为个人分账接收方');

    const [binding] = await query(
        `SELECT * FROM promotion_bindings
         WHERE user_id = ? AND promoter_user_id = ? AND root_promoter_user_id = ?
         LIMIT 1`,
        [normalizedChildUserId, normalizedParentUserId, normalizedParentUserId]
    );
    if (!binding) {
        throw new Error('只能把自己直接推广绑定的用户设置为二级推广员');
    }

    const [existing] = await query('SELECT * FROM promoters WHERE user_id = ? LIMIT 1', [normalizedChildUserId]);
    if (existing) {
        if (!existing.parent_promoter_user_id) {
            throw new Error('该用户已经是一级推广员，不能设置为二级推广员');
        }
        if (Number(existing.parent_promoter_user_id) !== normalizedParentUserId) {
            throw new Error('该用户已属于其他上级推广员');
        }
        await query(
            `UPDATE promoters
             SET status = 'active',
                 role_source = 'parent',
                 commission_rate_bps = ?,
                 max_child_rate_bps = 0,
                 created_by_promoter_user_id = ?
             WHERE user_id = ?`,
            [normalizedRate, normalizedParentUserId, normalizedChildUserId]
        );
    } else {
        const code = await generateUniquePromoterCode();
        await query(
            `INSERT INTO promoters (
                user_id, parent_promoter_user_id, promoter_code, role_source, status,
                commission_rate_bps, max_child_rate_bps, created_by_promoter_user_id
             ) VALUES (?, ?, ?, 'parent', 'active', ?, 0, ?)`,
            [normalizedChildUserId, normalizedParentUserId, code, normalizedRate, normalizedParentUserId]
        );
    }

    await ensurePersonalReceiverFromUser(normalizedChildUserId, { addStatus: 'pending' });
    return getPromoterDetail(normalizedChildUserId);
}

async function setPromoterStatus(userId, status) {
    await ensureReady();
    if (!['active', 'disabled'].includes(status)) throw new Error('无效状态');
    const result = await query('UPDATE promoters SET status = ? WHERE user_id = ?', [status, userId]);
    if (!result.affectedRows) throw new Error('推广员不存在');
    return getPromoterDetail(userId);
}

async function ensurePersonalReceiverFromUser(userId, { addStatus = 'pending' } = {}) {
    await ensureReady();
    const [promoter] = await query(
        `SELECT p.*, u.openid, u.nickname
         FROM promoters p
         JOIN users u ON u.id = p.user_id
         WHERE p.user_id = ?
         LIMIT 1`,
        [userId]
    );
    if (!promoter) throw new Error('推广员不存在');
    if (!promoter.openid) throw new Error('用户缺少 OpenID，无法作为个人分账接收方');

    const normalizedStatus = ['pending', 'added', 'failed', 'deleted'].includes(addStatus)
        ? addStatus
        : 'pending';
    const promoterReceiverStatus = normalizedStatus === 'added'
        ? 'added'
        : normalizedStatus === 'failed'
            ? 'failed'
            : 'pending';

    await query(
        `INSERT INTO profitsharing_receivers (
            promoter_user_id, receiver_type, receiver_account, receiver_name,
            relation_type, add_status, added_at
         ) VALUES (?, 'PERSONAL_OPENID', ?, ?, 'SERVICE_PROVIDER', ?, NULL)
         ON DUPLICATE KEY UPDATE
            receiver_type = 'PERSONAL_OPENID',
            receiver_account = VALUES(receiver_account),
            receiver_name = COALESCE(receiver_name, VALUES(receiver_name)),
            relation_type = 'SERVICE_PROVIDER',
            add_status = IF(add_status = 'added', add_status, VALUES(add_status)),
            add_error_code = IF(add_status = 'added', add_error_code, NULL),
            add_error_message = IF(add_status = 'added', add_error_message, NULL)`,
        [userId, promoter.openid, promoter.nickname || null, normalizedStatus]
    );

    await query('UPDATE promoters SET receiver_status = ? WHERE user_id = ?', [promoterReceiverStatus, userId]);
    return getPromoterDetail(userId);
}

async function upsertReceiver(userId, payload = {}) {
    return ensurePersonalReceiverFromUser(userId, { addStatus: payload.add_status || 'pending' });
}

async function bindUserToPromoter({ userId, promoterUserId, source = 'manual' }) {
    await ensureReady();
    const normalizedUserId = toInt(userId, 0);
    const normalizedPromoterUserId = toInt(promoterUserId, 0);

    if (!normalizedUserId || !normalizedPromoterUserId) throw new Error('绑定用户和推广员不能为空');
    if (normalizedUserId === normalizedPromoterUserId) throw new Error('不能把用户绑定到自己名下');

    const user = await findUser(normalizedUserId);
    if (!user) throw new Error('绑定用户不存在');

    const [promoter] = await query(
        'SELECT * FROM promoters WHERE user_id = ? LIMIT 1',
        [normalizedPromoterUserId]
    );
    if (!promoter) throw new Error('推广员不存在');
    if (promoter.status !== 'active') throw new Error('推广员未启用');

    const bindSource = ['qrcode', 'share', 'manual', 'system'].includes(source) ? source : 'manual';
    const rootPromoterUserId = promoter.parent_promoter_user_id || promoter.user_id;

    await query(
        `INSERT INTO promotion_bindings (
            user_id, promoter_user_id, root_promoter_user_id, promoter_code, bind_source, bound_at, locked
         ) VALUES (?, ?, ?, ?, ?, NOW(), 1)
         ON DUPLICATE KEY UPDATE
            promoter_user_id = VALUES(promoter_user_id),
            root_promoter_user_id = VALUES(root_promoter_user_id),
            promoter_code = VALUES(promoter_code),
            bind_source = VALUES(bind_source),
            bound_at = NOW(),
            locked = 1`,
        [normalizedUserId, promoter.user_id, rootPromoterUserId, promoter.promoter_code, bindSource]
    );

    return getPromoterDetail(promoter.user_id);
}

async function bindUserByPromoterCode({ userId, promoterCode, scene = '', source = 'qrcode' }) {
    await ensureReady();
    const normalizedUserId = toInt(userId, 0);
    const code = normalizePromoterCode(promoterCode) || parsePromoterScene(scene);
    if (!normalizedUserId || !code) {
        return { bound: false, reason: 'missing_code' };
    }

    const user = await findUser(normalizedUserId);
    if (!user) {
        return { bound: false, reason: 'user_not_found' };
    }

    const [promoter] = await query(
        'SELECT * FROM promoters WHERE promoter_code = ? AND status = ? LIMIT 1',
        [code, 'active']
    );
    if (!promoter) {
        return { bound: false, reason: 'invalid_code' };
    }

    if (promoter.user_id === normalizedUserId) {
        return {
            bound: false,
            reason: 'self',
            promoter_user_id: promoter.user_id
        };
    }

    const [existing] = await query(
        'SELECT * FROM promotion_bindings WHERE user_id = ? LIMIT 1',
        [normalizedUserId]
    );
    if (existing) {
        return {
            bound: false,
            reason: existing.promoter_user_id === promoter.user_id ? 'already_bound_current' : 'already_bound',
            promoter_user_id: existing.promoter_user_id,
            root_promoter_user_id: existing.root_promoter_user_id
        };
    }

    const bindSource = ['qrcode', 'share', 'manual', 'system'].includes(source) ? source : 'qrcode';
    const rootPromoterUserId = promoter.parent_promoter_user_id || promoter.user_id;

    await query(
        `INSERT INTO promotion_bindings (
            user_id, promoter_user_id, root_promoter_user_id, promoter_code, bind_source, bound_at, locked
         ) VALUES (?, ?, ?, ?, ?, NOW(), 1)`,
        [normalizedUserId, promoter.user_id, rootPromoterUserId, promoter.promoter_code, bindSource]
    );

    return {
        bound: true,
        reason: 'bound',
        promoter_user_id: promoter.user_id,
        root_promoter_user_id: rootPromoterUserId
    };
}

async function getPromoterDetail(userId) {
    await ensureReady();
    const [detail] = await query(`
        SELECT p.*,
               u.nickname, u.avatar_url, u.phone, u.openid, u.created_at AS user_created_at,
               parent.nickname AS parent_nickname,
               r.receiver_type, r.receiver_account, r.receiver_name, r.relation_type,
               r.add_status, r.add_error_code, r.add_error_message, r.added_at
        FROM promoters p
        JOIN users u ON u.id = p.user_id
        LEFT JOIN users parent ON parent.id = p.parent_promoter_user_id
        LEFT JOIN profitsharing_receivers r ON r.promoter_user_id = p.user_id
        WHERE p.user_id = ?
        LIMIT 1
    `, [userId]);
    return detail || null;
}

function maskReceiverAccount(account = '') {
    const value = String(account || '').trim();
    if (!value) return '';
    if (value.length <= 8) return `${value.slice(0, 2)}****`;
    return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

function formatRatePercent(rateBps) {
    const n = Number(rateBps || 0) / 100;
    return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function decoratePromoterBinding(item, currentPromoter) {
    const currentUserId = Number(currentPromoter.user_id || 0);
    return {
        id: item.id,
        user_id: item.user_id,
        nickname: item.nickname || `用户${item.user_id}`,
        avatar_url: item.avatar_url || '',
        phone: item.phone || '',
        bind_source: item.bind_source,
        promoter_user_id: item.promoter_user_id,
        root_promoter_user_id: item.root_promoter_user_id,
        promoter_nickname: item.promoter_nickname || '',
        bound_at: item.bound_at,
        is_child_promoter: Number(item.child_parent_promoter_user_id || 0) === currentUserId && item.child_promoter_status === 'active',
        child_promoter_status: item.child_promoter_status || '',
        child_parent_promoter_user_id: item.child_parent_promoter_user_id || null,
        child_commission_rate_bps: item.child_commission_rate_bps || 0,
        child_commission_rate_percent: formatRatePercent(item.child_commission_rate_bps || 0),
        can_set_child_promoter: !currentPromoter.parent_promoter_user_id &&
            Number(item.promoter_user_id) === currentUserId &&
            Number(item.root_promoter_user_id) === currentUserId &&
            Number(item.user_id) !== currentUserId &&
            (!item.child_parent_promoter_user_id || Number(item.child_parent_promoter_user_id) === currentUserId)
    };
}

async function getPromoterIdentity(userId) {
    await ensureReady();
    const [promoter] = await query(
        `SELECT user_id, promoter_code, status, commission_rate_bps, max_child_rate_bps,
                receiver_status, parent_promoter_user_id, created_at
         FROM promoters
         WHERE user_id = ?
         LIMIT 1`,
        [userId]
    );

    if (!promoter) {
        return {
            is_promoter: false,
            promoter_status: null,
            promoter_code: '',
            commission_rate_bps: 0,
            commission_rate_percent: '0',
            receiver_status: 'missing'
        };
    }

    return {
        is_promoter: promoter.status === 'active',
        promoter_status: promoter.status,
        promoter_code: promoter.promoter_code,
        commission_rate_bps: promoter.commission_rate_bps,
        commission_rate_percent: formatRatePercent(promoter.commission_rate_bps),
        receiver_status: promoter.receiver_status,
        promoter_level: promoter.parent_promoter_user_id ? 'child' : 'root',
        promoter_created_at: promoter.created_at
    };
}

async function getPromoterDashboard(userId) {
    await ensureReady();
    const detail = await getPromoterDetail(userId);
    if (!detail || detail.status !== 'active') return null;

    const [directCount] = await query(
        'SELECT COUNT(*) AS total FROM promotion_bindings WHERE promoter_user_id = ?',
        [userId]
    );
    const [rootCount] = await query(
        'SELECT COUNT(*) AS total FROM promotion_bindings WHERE root_promoter_user_id = ?',
        [userId]
    );
    const [childCount] = await query(
        'SELECT COUNT(*) AS total FROM promoters WHERE parent_promoter_user_id = ?',
        [userId]
    );
    const recentBindings = await query(
        `SELECT pb.id, pb.user_id, pb.promoter_user_id, pb.root_promoter_user_id, pb.bind_source, pb.bound_at,
                u.nickname, u.avatar_url, u.phone,
                direct_owner.nickname AS promoter_nickname,
                child_p.status AS child_promoter_status,
                child_p.parent_promoter_user_id AS child_parent_promoter_user_id,
                child_p.commission_rate_bps AS child_commission_rate_bps
         FROM promotion_bindings pb
         JOIN users u ON u.id = pb.user_id
         LEFT JOIN users direct_owner ON direct_owner.id = pb.promoter_user_id
         LEFT JOIN promoters child_p ON child_p.user_id = pb.user_id
         WHERE pb.promoter_user_id = ? OR pb.root_promoter_user_id = ?
         ORDER BY pb.bound_at DESC
         LIMIT 10`,
        [userId, userId]
    );

    const receiverAccount = detail.receiver_account || '';
    const receiver = {
        status: detail.receiver_status || 'missing',
        add_status: detail.add_status || null,
        type: detail.receiver_type || '',
        relation_type: detail.relation_type || '',
        name: detail.receiver_name || '',
        account_masked: maskReceiverAccount(receiverAccount),
        added_at: detail.added_at || null,
        error_message: detail.add_error_message || ''
    };

    return {
        promoter: {
            user_id: detail.user_id,
            nickname: detail.nickname,
            avatar_url: detail.avatar_url,
            level: detail.parent_promoter_user_id ? 'child' : 'root',
            parent_nickname: detail.parent_nickname || '',
            promoter_code: detail.promoter_code,
            qr_code_url: detail.qr_code_url || '',
            status: detail.status,
            commission_rate_bps: detail.commission_rate_bps,
            commission_rate_percent: formatRatePercent(detail.commission_rate_bps),
            max_child_rate_bps: detail.max_child_rate_bps,
            max_child_rate_percent: formatRatePercent(detail.max_child_rate_bps),
            receiver_status: detail.receiver_status,
            created_at: detail.created_at
        },
        receiver,
        summary: {
            direct_user_count: directCount ? Number(directCount.total || 0) : 0,
            root_user_count: rootCount ? Number(rootCount.total || 0) : 0,
            child_promoter_count: childCount ? Number(childCount.total || 0) : 0,
            total_sales_cent: Number(detail.total_sales_cent || 0),
            total_profitsharing_cent: Number(detail.total_profitsharing_cent || 0)
        },
        recent_bindings: recentBindings.map((item) => decoratePromoterBinding(item, detail))
    };
}

async function getPromoterBindings({ userId, page = 1, limit = 10, keyword = '' } = {}) {
    await ensureReady();
    const detail = await getPromoterDetail(userId);
    if (!detail || detail.status !== 'active') return null;

    const normalizedPage = Math.max(1, toInt(page, 1));
    const normalizedLimit = Math.min(50, Math.max(5, toInt(limit, 10)));
    const offset = (normalizedPage - 1) * normalizedLimit;
    const where = ['(pb.promoter_user_id = ? OR pb.root_promoter_user_id = ?)'];
    const params = [detail.user_id, detail.user_id];
    const search = String(keyword || '').trim();

    if (search) {
        const like = `%${search}%`;
        if (/^\d+$/.test(search)) {
            where.push('(u.id = ? OR u.nickname LIKE ? OR u.phone LIKE ?)');
            params.push(Number(search), like, like);
        } else {
            where.push('(u.nickname LIKE ? OR u.phone LIKE ?)');
            params.push(like, like);
        }
    }

    const sqlWhere = where.join(' AND ');
    const [countRow] = await query(`
        SELECT COUNT(*) AS total
        FROM promotion_bindings pb
        JOIN users u ON u.id = pb.user_id
        WHERE ${sqlWhere}
    `, params);

    const list = await query(`
        SELECT pb.id, pb.user_id, pb.promoter_user_id, pb.root_promoter_user_id, pb.bind_source, pb.bound_at,
               u.nickname, u.avatar_url, u.phone,
               direct_owner.nickname AS promoter_nickname,
               child_p.status AS child_promoter_status,
               child_p.parent_promoter_user_id AS child_parent_promoter_user_id,
               child_p.commission_rate_bps AS child_commission_rate_bps
        FROM promotion_bindings pb
        JOIN users u ON u.id = pb.user_id
        LEFT JOIN users direct_owner ON direct_owner.id = pb.promoter_user_id
        LEFT JOIN promoters child_p ON child_p.user_id = pb.user_id
        WHERE ${sqlWhere}
        ORDER BY pb.bound_at DESC
        LIMIT ? OFFSET ?
    `, [...params, normalizedLimit, offset]);

    const total = countRow ? Number(countRow.total || 0) : 0;
    return {
        list: list.map((item) => decoratePromoterBinding(item, detail)),
        pagination: {
            page: normalizedPage,
            limit: normalizedLimit,
            total,
            has_more: normalizedPage * normalizedLimit < total
        }
    };
}

module.exports = {
    MAX_PROFITSHARING_RATE_BPS,
    ensurePromotionTables,
    ensureReady,
    normalizeRateBps,
    normalizePromoterCode,
    parsePromoterScene,
    generatePromoterQrCode,
    bindUserByPromoterCode,
    enableChildPromoterByParent,
    getPromoterIdentity,
    getPromoterDashboard,
    getPromoterBindings,
    enableRootPromoter,
    updateRootPromoterRate,
    setPromoterStatus,
    upsertReceiver,
    bindUserToPromoter,
    getPromoterDetail
};
