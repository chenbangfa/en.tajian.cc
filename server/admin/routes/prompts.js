const express = require('express');
const { query } = require('../../src/config/database');

const router = express.Router();

/**
 * 获取所有提示词
 */
router.get('/', async (req, res) => {
    try {
        const prompts = await query('SELECT * FROM ai_prompts ORDER BY id');
        res.json({ success: true, data: prompts });
    } catch (error) {
        console.error('获取提示词列表错误:', error);
        res.status(500).json({ success: false, message: '获取失败' });
    }
});

/**
 * 根据key获取单个提示词
 */
router.get('/by-key/:key', async (req, res) => {
    try {
        const { key } = req.params;
        const [prompt] = await query('SELECT * FROM ai_prompts WHERE prompt_key = ?', [key]);
        if (!prompt) {
            return res.status(404).json({ success: false, message: '提示词不存在' });
        }
        res.json({ success: true, data: prompt });
    } catch (error) {
        console.error('获取提示词错误:', error);
        res.status(500).json({ success: false, message: '获取失败' });
    }
});

/**
 * 根据ID获取单个提示词
 */
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const [prompt] = await query('SELECT * FROM ai_prompts WHERE id = ?', [id]);
        if (!prompt) {
            return res.status(404).json({ success: false, message: '提示词不存在' });
        }
        res.json({ success: true, data: prompt });
    } catch (error) {
        console.error('获取提示词错误:', error);
        res.status(500).json({ success: false, message: '获取失败' });
    }
});

/**
 * 更新提示词
 */
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { prompt_name, prompt_template, description, is_active } = req.body;

        await query(
            `UPDATE ai_prompts SET 
                prompt_name = ?, 
                prompt_template = ?, 
                description = ?,
                is_active = ?
            WHERE id = ?`,
            [prompt_name, prompt_template, description, is_active !== false, id]
        );

        res.json({ success: true, message: '更新成功' });
    } catch (error) {
        console.error('更新提示词错误:', error);
        res.status(500).json({ success: false, message: '更新失败' });
    }
});

/**
 * 新增提示词
 */
router.post('/', async (req, res) => {
    try {
        const { prompt_key, prompt_name, prompt_template, description } = req.body;

        if (!prompt_key || !prompt_name || !prompt_template) {
            return res.status(400).json({ success: false, message: '缺少必要参数' });
        }

        const result = await query(
            `INSERT INTO ai_prompts (prompt_key, prompt_name, prompt_template, description) 
             VALUES (?, ?, ?, ?)`,
            [prompt_key, prompt_name, prompt_template, description]
        );

        res.json({ success: true, data: { id: result.insertId }, message: '添加成功' });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ success: false, message: '提示词标识已存在' });
        }
        console.error('添加提示词错误:', error);
        res.status(500).json({ success: false, message: '添加失败' });
    }
});

/**
 * 删除提示词
 */
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await query('DELETE FROM ai_prompts WHERE id = ?', [id]);
        res.json({ success: true, message: '删除成功' });
    } catch (error) {
        console.error('删除提示词错误:', error);
        res.status(500).json({ success: false, message: '删除失败' });
    }
});

module.exports = router;
