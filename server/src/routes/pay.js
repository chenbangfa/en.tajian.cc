// src/routes/pay.js - 微信支付 v3 API
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const { query } = require('../config/database');
const { authMiddleware } = require('../middlewares/auth');

const router = express.Router();

// ===== 配置 =====
const MCH_ID     = process.env.WX_MCH_ID;
const SERIAL_NO  = process.env.WX_CERT_SERIAL;
const API_V3_KEY = process.env.WX_API_V3_KEY;
const APP_ID     = process.env.WECHAT_APPID;
const NOTIFY_URL = process.env.WX_NOTIFY_URL || 'https://english.tajian.cc/api/pay/notify';
const WX_BASE    = 'https://api.mch.weixin.qq.com';

let privateKeyCache = null;

function getPrivateKey() {
    if (privateKeyCache) return privateKeyCache;
    const certPath = path.resolve(process.env.WX_CERT_KEY_PATH || path.join(__dirname, '../../certs/apiclient_key.pem'));
    privateKeyCache = fs.readFileSync(certPath);
    return privateKeyCache;
}

// 商品定义
const PRODUCTS = {
    month: { name: '月度VIP会员', price: 1990,  days: 30,  points: 3000 },
    year:  { name: '年度VIP会员', price: 16800, days: 365, points: 36000 },
    p1:    { name: '600积分包',   price: 600,   points: 600,  type: 'points' },
    p2:    { name: '2000积分包',  price: 1800,  points: 2000, type: 'points' },
    p3:    { name: '8000积分包',  price: 6800,  points: 8000, type: 'points' }
};

// 自动建表
async function ensureOrderTable() {
    await query(`CREATE TABLE IF NOT EXISTS pay_orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_no VARCHAR(64) NOT NULL UNIQUE,
        user_id INT NOT NULL,
        product_id VARCHAR(32) NOT NULL,
        product_name VARCHAR(64) NOT NULL,
        amount INT NOT NULL COMMENT '单位分',
        status ENUM('pending','paid','failed','refunded') DEFAULT 'pending',
        transaction_id VARCHAR(64) DEFAULT NULL,
        openid VARCHAR(64) NOT NULL,
        profit_sharing TINYINT(1) NOT NULL DEFAULT 0 COMMENT '微信支付下单是否指定分账',
        profitsharing_status ENUM('not_required','pending','processing','success','partial_success','failed','receiver_missing','unfrozen') NOT NULL DEFAULT 'not_required',
        profitsharing_processed_at DATETIME DEFAULT NULL,
        profitsharing_error VARCHAR(255) DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        paid_at DATETIME DEFAULT NULL,
        INDEX idx_user (user_id),
        INDEX idx_order_no (order_no),
        INDEX idx_profitsharing_status (profitsharing_status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await ensureColumn('pay_orders', 'profit_sharing', "TINYINT(1) NOT NULL DEFAULT 0 COMMENT '微信支付下单是否指定分账'");
    await ensureColumn('pay_orders', 'profitsharing_status', "ENUM('not_required','pending','processing','success','partial_success','failed','receiver_missing','unfrozen') NOT NULL DEFAULT 'not_required'");
    await ensureColumn('pay_orders', 'profitsharing_processed_at', 'DATETIME DEFAULT NULL');
    await ensureColumn('pay_orders', 'profitsharing_error', 'VARCHAR(255) DEFAULT NULL');
    await ensureIndex('pay_orders', 'idx_profitsharing_status', 'profitsharing_status');
}

async function ensureColumn(table, column, definition) {
    try {
        await query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch (e) {
        if (e && (e.code === 'ER_DUP_FIELDNAME' || /Duplicate column/i.test(e.message))) return;
        throw e;
    }
}

async function ensureIndex(table, indexName, columns) {
    try {
        await query(`ALTER TABLE ${table} ADD INDEX ${indexName} (${columns})`);
    } catch (e) {
        if (e && (e.code === 'ER_DUP_KEYNAME' || /Duplicate key name/i.test(e.message))) return;
        throw e;
    }
}

const orderTableReady = ensureOrderTable();
orderTableReady.catch(e => {
    console.error('[Pay] 建表失败:', e);
});

// ===== 签名工具 =====
function genNonce() {
    return crypto.randomBytes(16).toString('hex').toUpperCase();
}

function genOrderNo() {
    return 'EN' + Date.now() + Math.floor(Math.random() * 1000).toString().padStart(3, '0');
}

// 构造 Authorization 头
function buildAuthHeader(method, urlPath, body = '') {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = genNonce();
    const message = `${method}\n${urlPath}\n${timestamp}\n${nonce}\n${body}\n`;
    const sign = crypto.createSign('RSA-SHA256').update(message).sign(getPrivateKey(), 'base64');
    return {
        Authorization: `WECHATPAY2-SHA256-RSA2048 mchid="${MCH_ID}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${SERIAL_NO}",signature="${sign}"`,
        timestamp,
        nonce
    };
}

// 签名小程序调起支付参数
function signPayParams(prepayId) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = genNonce();
    const pkg = `prepay_id=${prepayId}`;
    const message = `${APP_ID}\n${timestamp}\n${nonce}\n${pkg}\n`;
    const paySign = crypto.createSign('RSA-SHA256').update(message).sign(getPrivateKey(), 'base64');
    return { timeStamp: timestamp, nonceStr: nonce, package: pkg, signType: 'RSA', paySign };
}

function parseNotifyBody(reqBody) {
    if (!reqBody) throw new Error('empty notify body');
    if (Buffer.isBuffer(reqBody)) return JSON.parse(reqBody.toString('utf8'));
    if (typeof reqBody === 'string') return JSON.parse(reqBody);
    if (typeof reqBody === 'object') return reqBody;
    throw new Error('invalid notify body');
}

function decryptNotifyResource(resource) {
    if (!resource || !resource.ciphertext || !resource.nonce) {
        throw new Error('invalid notify resource');
    }
    const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        Buffer.from(API_V3_KEY, 'utf8'),
        Buffer.from(resource.nonce, 'utf8')
    );
    if (resource.associated_data) {
        decipher.setAAD(Buffer.from(resource.associated_data, 'utf8'));
    }
    const ciphertext = Buffer.from(resource.ciphertext, 'base64');
    const authTag = ciphertext.subarray(ciphertext.length - 16);
    const encrypted = ciphertext.subarray(0, ciphertext.length - 16);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
}

async function hasActivePromotionBinding(userId) {
    try {
        const rows = await query(`
            SELECT pb.user_id
            FROM promotion_bindings pb
            JOIN promoters p ON p.user_id = pb.promoter_user_id
            WHERE pb.user_id = ? AND p.status = 'active'
            LIMIT 1
        `, [userId]);
        return rows.length > 0;
    } catch (e) {
        if (e && e.code === 'ER_NO_SUCH_TABLE') return false;
        throw e;
    }
}

// ===== POST /pay/create-order =====
router.post('/create-order', authMiddleware, async (req, res) => {
    try {
        await orderTableReady;

        const { product_id } = req.body;
        const product = PRODUCTS[product_id];
        if (!product) return res.status(400).json({ success: false, message: '商品不存在' });

        const userId = req.user.id;
        const [user] = await query('SELECT openid FROM users WHERE id = ?', [userId]);
        if (!user || !user.openid) {
            return res.status(400).json({ success: false, message: '用户信息不完整，请重新登录' });
        }

        const orderNo = genOrderNo();
        const profitSharing = await hasActivePromotionBinding(userId);
        const profitsharingStatus = profitSharing ? 'pending' : 'not_required';

        await query(
            `INSERT INTO pay_orders (order_no, user_id, product_id, product_name, amount, openid, profit_sharing, profitsharing_status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [orderNo, userId, product_id, product.name, product.price, user.openid, profitSharing ? 1 : 0, profitsharingStatus]
        );

        const bodyData = {
            appid: APP_ID,
            mchid: MCH_ID,
            description: product.name,
            out_trade_no: orderNo,
            notify_url: NOTIFY_URL,
            amount: { total: product.price, currency: 'CNY' },
            payer: { openid: user.openid }
        };
        if (profitSharing) {
            bodyData.profit_sharing = true;
        }
        const bodyStr = JSON.stringify(bodyData);
        const urlPath = '/v3/pay/transactions/jsapi';
        const { Authorization } = buildAuthHeader('POST', urlPath, bodyStr);

        const wxRes = await axios.post(`${WX_BASE}${urlPath}`, bodyData, {
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': Authorization,
                'User-Agent': 'EnglishLearning/1.0'
            }
        });

        const prepayId = wxRes.data.prepay_id;
        const payParams = signPayParams(prepayId);

        res.json({ success: true, data: { order_no: orderNo, ...payParams } });

    } catch (e) {
        const errData = e.response ? e.response.data : e.message;
        console.error('[Pay] 创建订单失败:', JSON.stringify(errData));
        res.status(500).json({ success: false, message: '创建订单失败，请稍后再试' });
    }
});

// ===== POST /pay/notify（微信异步回调）=====
router.post('/notify', express.raw({ type: '*/*' }), async (req, res) => {
    try {
        await orderTableReady;

        const body = parseNotifyBody(req.body);
        const decrypted = decryptNotifyResource(body.resource);
        const tradeData = JSON.parse(decrypted);

        console.log('[Pay] 回调:', tradeData.out_trade_no, tradeData.trade_state);

        if (tradeData.trade_state === 'SUCCESS') {
            await handlePaySuccess(tradeData);
        }

        res.json({ code: 'SUCCESS', message: '成功' });
    } catch (e) {
        console.error('[Pay] 回调处理失败:', e.message);
        res.json({ code: 'SUCCESS', message: '成功' });
    }
});

async function handlePaySuccess(trade) {
    const { out_trade_no: orderNo, transaction_id: transactionId } = trade;
    const [order] = await query('SELECT * FROM pay_orders WHERE order_no = ?', [orderNo]);
    if (!order || order.status === 'paid') return;

    await query(
        'UPDATE pay_orders SET status="paid", transaction_id=?, paid_at=NOW() WHERE order_no=?',
        [transactionId, orderNo]
    );

    const product = PRODUCTS[order.product_id];
    if (!product) return;

    if (product.type === 'points') {
        await query('UPDATE users SET points = points + ? WHERE id = ?', [product.points, order.user_id]);
        console.log(`[Pay] 用户 ${order.user_id} 充值 ${product.points} 积分`);
    } else {
        const [user] = await query('SELECT vip_expire_date FROM users WHERE id = ?', [order.user_id]);
        const now = new Date();
        const base = (user && user.vip_expire_date && new Date(user.vip_expire_date) > now)
            ? new Date(user.vip_expire_date) : now;
        const expire = new Date(base.getTime() + product.days * 86400000);
        const expireStr = expire.toISOString().split('T')[0];
        await query(
            'UPDATE users SET vip_level=1, vip_expire_date=?, points=points+? WHERE id=?',
            [expireStr, product.points, order.user_id]
        );
        console.log(`[Pay] 用户 ${order.user_id} VIP 开通至 ${expireStr}`);
    }

    if (Number(order.profit_sharing) === 1) {
        await query(
            `UPDATE pay_orders
             SET profitsharing_status = 'pending', profitsharing_error = NULL
             WHERE order_no = ? AND profitsharing_status IN ('not_required', 'failed')`,
            [orderNo]
        );
        console.log(`[Pay] 订单 ${orderNo} 已标记待微信分账`);
    }
}

// ===== GET /pay/order-status =====
router.get('/order-status', authMiddleware, async (req, res) => {
    try {
        const { order_no } = req.query;
        const [order] = await query(
            'SELECT status, product_id FROM pay_orders WHERE order_no = ? AND user_id = ?',
            [order_no, req.user.id]
        );
        if (!order) return res.status(404).json({ success: false, message: '订单不存在' });
        res.json({ success: true, data: { status: order.status, product_id: order.product_id } });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

module.exports = router;
