// 本地测试有道OCR - 直接调用API查看原始返回
require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

async function testYoudaoOCR() {
    const imagePath = path.join(__dirname, '../test.png');
    console.log('Testing Youdao OCR with:', imagePath);

    const appKey = process.env.YOUDAO_APP_KEY;
    const appSecret = process.env.YOUDAO_APP_SECRET;

    console.log('AppKey:', appKey);
    console.log('AppSecret:', appSecret ? '***configured***' : 'MISSING');

    if (!appKey || !appSecret) {
        console.error('Missing Youdao credentials!');
        return;
    }

    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString('base64');

    const salt = uuidv4();
    const curtime = Math.round(Date.now() / 1000).toString();
    const input = base64Image.length <= 20
        ? base64Image
        : base64Image.substring(0, 10) + base64Image.length + base64Image.substring(base64Image.length - 10);

    const signStr = appKey + input + salt + curtime + appSecret;
    const sign = crypto.createHash('sha256').update(signStr).digest('hex');

    try {
        const response = await axios.post(
            'https://openapi.youdao.com/ocrapi',
            new URLSearchParams({
                img: base64Image,
                langType: 'zh-CHS',
                detectType: '10012',
                imageType: '1',
                appKey,
                salt,
                sign,
                signType: 'v3',
                curtime
            }),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        console.log('Raw Response:', JSON.stringify(response.data, null, 2));
    } catch (error) {
        console.error('Error:', error.message, error.response?.data);
    }
}

testYoudaoOCR();
