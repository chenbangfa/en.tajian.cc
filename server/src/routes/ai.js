const express = require('express');
const multer = require('multer');
const path = require('path');
const { authMiddleware, requirePoints } = require('../middlewares/auth');
const { query } = require('../config/database');
const aiService = require('../services/ai.service');

const router = express.Router();

// 配置文件上传
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, path.join(__dirname, '../../uploads/temp'));
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('不支持的图片格式'));
        }
    }
});

// 生成单词图片
router.post('/generate-image', authMiddleware, requirePoints(5), async (req, res) => {
    try {
        const { word, style = 'realistic' } = req.body;

        if (!word) {
            return res.status(400).json({
                success: false,
                message: '请提供单词'
            });
        }

        // 调用AI生成图片
        const result = await aiService.generateWordImage(word, style);

        if (!result.success) {
            return res.status(500).json({
                success: false,
                message: result.error || '图片生成失败'
            });
        }

        // 扣除积分
        await query(
            'UPDATE users SET points = points - ? WHERE id = ?',
            [req.pointsToDeduct, req.user.id]
        );

        // 记录积分消耗
        await query(
            'INSERT INTO points_logs (user_id, change_amount, change_type, description) VALUES (?, ?, ?, ?)',
            [req.user.id, -req.pointsToDeduct, 'consume', `生成单词图片: ${word}`]
        );

        res.json({
            success: true,
            data: {
                image_url: result.imageUrl,
                word
            }
        });
    } catch (error) {
        console.error('生成图片错误:', error);
        res.status(500).json({
            success: false,
            message: '生成图片失败'
        });
    }
});

// 生成场景图片
router.post('/generate-scene', authMiddleware, requirePoints(10), async (req, res) => {
    try {
        const { scene_name, scene_description } = req.body;

        if (!scene_name) {
            return res.status(400).json({
                success: false,
                message: '请提供场景名称'
            });
        }

        // 调用AI生成场景图片
        const result = await aiService.generateSceneImage(scene_name, scene_description);

        if (!result.success) {
            return res.status(500).json({
                success: false,
                message: result.error || '场景图片生成失败'
            });
        }

        // 扣除积分
        await query(
            'UPDATE users SET points = points - ? WHERE id = ?',
            [req.pointsToDeduct, req.user.id]
        );

        await query(
            'INSERT INTO points_logs (user_id, change_amount, change_type, description) VALUES (?, ?, ?, ?)',
            [req.user.id, -req.pointsToDeduct, 'consume', `生成场景图片: ${scene_name}`]
        );

        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        console.error('生成场景图片错误:', error);
        res.status(500).json({
            success: false,
            message: '生成场景图片失败'
        });
    }
});

// 拍照识别
router.post('/recognize', authMiddleware, requirePoints(8), upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: '请上传图片'
            });
        }

        // 调用AI识别图片内容
        const recognizeResult = await aiService.recognizeImage(req.file.path);

        if (!recognizeResult.success) {
            return res.status(500).json({
                success: false,
                message: recognizeResult.error || '图片识别失败'
            });
        }

        // 调用有道OCR识别图片中的英文单词和位置
        const ocrResult = await aiService.youdaoOCR(req.file.path);

        // 扣除积分
        await query(
            'UPDATE users SET points = points - ? WHERE id = ?',
            [req.pointsToDeduct, req.user.id]
        );

        await query(
            'INSERT INTO points_logs (user_id, change_amount, change_type, description) VALUES (?, ?, ?, ?)',
            [req.user.id, -req.pointsToDeduct, 'consume', '拍照识别']
        );

        res.json({
            success: true,
            data: {
                objects: recognizeResult.objects,
                words: ocrResult.words || [],
                image_path: req.file.path
            }
        });
    } catch (error) {
        console.error('图片识别错误:', error);
        res.status(500).json({
            success: false,
            message: '图片识别失败'
        });
    }
});

module.exports = router;
