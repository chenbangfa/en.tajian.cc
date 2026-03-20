const { query } = require('../config/database');

class RewardService {
    /**
     * 检查并发放奖励
     * @param {number} userId
     * @param {string} ruleType - 'checkin_complete' | 'high_score' | 'streak_days' | 'book_complete'
     * @param {object} context - { score, streakDays, ... }
     * @returns {{ rewarded, flowers, growth, levelUp, newStage }}
     */
    async checkAndReward(userId, ruleType, context = {}) {
        // 1. 查用户的规则
        const [rule] = await query(
            'SELECT * FROM reward_rules WHERE user_id = ? AND rule_type = ? AND enabled = 1',
            [userId, ruleType]
        );
        if (!rule) return { rewarded: false };

        // 2. 检查阈值
        if (rule.threshold > 0) {
            const val = context.score || context.streakDays || 0;
            if (val < rule.threshold) return { rewarded: false };
        }

        // 3. 防重复：同天同规则
        //    若传入 sourceKey（如单词ID），则按 规则+sourceKey 去重（每个单词每天最多奖励1次）
        //    否则按 规则 去重（每天最多奖励1次）
        const today = new Date().toISOString().slice(0, 10);
        let dedupSql, dedupParams;
        if (context.sourceKey) {
            dedupSql = `SELECT id FROM flower_transactions
                        WHERE user_id = ? AND source_type = 'rule_reward' AND source_id = ?
                        AND description LIKE ? AND DATE(created_at) = ?`;
            dedupParams = [userId, rule.id, `%[${context.sourceKey}]%`, today];
        } else {
            dedupSql = `SELECT id FROM flower_transactions
                        WHERE user_id = ? AND source_type = 'rule_reward' AND source_id = ?
                        AND DATE(created_at) = ?`;
            dedupParams = [userId, rule.id, today];
        }
        const [existing] = await query(dedupSql, dedupParams);
        if (existing) return { rewarded: false, reason: 'already_rewarded_today' };

        // 4. 获取当前余额
        const [lastTx] = await query(
            'SELECT balance_after FROM flower_transactions WHERE user_id = ? ORDER BY id DESC LIMIT 1',
            [userId]
        );
        const currentBalance = lastTx ? lastTx.balance_after : 0;
        const newBalance = currentBalance + rule.flowers;

        // 5. 写流水
        let desc = this._ruleDescription(ruleType, rule);
        if (context.sourceKey) desc += ` [${context.sourceKey}]`;
        await query(
            `INSERT INTO flower_transactions (user_id, amount, growth_amount, balance_after, source_type, source_id, description)
             VALUES (?, ?, ?, ?, 'rule_reward', ?, ?)`,
            [userId, rule.flowers, rule.growth, newBalance, rule.id, desc]
        );

        // 6. 更新伙伴成长值 + 健康
        const levelUpInfo = await this._updatePetGrowth(userId, rule.growth);

        return {
            rewarded: true,
            flowers: rule.flowers,
            growth: rule.growth,
            balance: newBalance,
            ...levelUpInfo
        };
    }

    /**
     * 手动赠花（家长）
     */
    async giftFlowers(userId, flowers, growth, description) {
        const [lastTx] = await query(
            'SELECT balance_after FROM flower_transactions WHERE user_id = ? ORDER BY id DESC LIMIT 1',
            [userId]
        );
        const currentBalance = lastTx ? lastTx.balance_after : 0;
        const newBalance = currentBalance + flowers;

        await query(
            `INSERT INTO flower_transactions (user_id, amount, growth_amount, balance_after, source_type, description)
             VALUES (?, ?, ?, ?, 'parent_gift', ?)`,
            [userId, flowers, growth, newBalance, description || '家长奖励']
        );

        const levelUpInfo = await this._updatePetGrowth(userId, growth);
        return { balance: newBalance, ...levelUpInfo };
    }

    /**
     * 兑换扣花
     */
    async deductFlowers(userId, cost, exchangeId, description) {
        const [lastTx] = await query(
            'SELECT balance_after FROM flower_transactions WHERE user_id = ? ORDER BY id DESC LIMIT 1',
            [userId]
        );
        const currentBalance = lastTx ? lastTx.balance_after : 0;
        if (currentBalance < cost) return { success: false, message: '余额不足' };

        const newBalance = currentBalance - cost;
        await query(
            `INSERT INTO flower_transactions (user_id, amount, growth_amount, balance_after, source_type, source_id, description)
             VALUES (?, ?, 0, ?, 'exchange', ?, ?)`,
            [userId, -cost, newBalance, exchangeId, description]
        );
        return { success: true, balance: newBalance };
    }

    /**
     * 获取余额
     */
    async getBalance(userId) {
        const [lastTx] = await query(
            'SELECT balance_after FROM flower_transactions WHERE user_id = ? ORDER BY id DESC LIMIT 1',
            [userId]
        );
        return lastTx ? lastTx.balance_after : 0;
    }

    /**
     * 更新伙伴成长值，检查升级
     */
    async _updatePetGrowth(userId, growthAmount) {
        if (!growthAmount || growthAmount <= 0) return { levelUp: false };

        const [pet] = await query('SELECT * FROM user_pet WHERE user_id = ?', [userId]);
        if (!pet) return { levelUp: false };

        const newPoints = pet.growth_points + growthAmount;
        const today = new Date().toISOString().slice(0, 10);

        // 查下一阶段
        const [nextStage] = await query(
            `SELECT * FROM pet_growth_stages
             WHERE pet_type = ? AND required_points > ?
             ORDER BY required_points ASC LIMIT 1`,
            [pet.pet_type, pet.growth_points]
        );

        let levelUp = false;
        let newStage = null;

        if (nextStage && newPoints >= nextStage.required_points) {
            // 升级：找到新的实际阶段
            const [actualStage] = await query(
                `SELECT * FROM pet_growth_stages
                 WHERE pet_type = ? AND required_points <= ?
                 ORDER BY required_points DESC LIMIT 1`,
                [pet.pet_type, newPoints]
            );
            if (actualStage && actualStage.stage > pet.growth_stage) {
                levelUp = true;
                newStage = actualStage;
                await query(
                    `UPDATE user_pet SET growth_points = ?, growth_stage = ?,
                     health_status = 'healthy', last_activity_date = ? WHERE user_id = ?`,
                    [newPoints, actualStage.stage, today, userId]
                );
            } else {
                await query(
                    `UPDATE user_pet SET growth_points = ?, health_status = 'healthy',
                     last_activity_date = ? WHERE user_id = ?`,
                    [newPoints, today, userId]
                );
            }
        } else {
            await query(
                `UPDATE user_pet SET growth_points = ?, health_status = 'healthy',
                 last_activity_date = ? WHERE user_id = ?`,
                [newPoints, today, userId]
            );
        }

        return { levelUp, newStage };
    }

    _ruleDescription(ruleType, rule) {
        const map = {
            'checkin_complete': `完成每日打卡 +${rule.flowers}`,
            'high_score': `评测得分≥${rule.threshold} +${rule.flowers}`,
            'streak_days': `连续打卡${rule.threshold}天 +${rule.flowers}`,
            'book_complete': `完成绘本阅读 +${rule.flowers}`
        };
        return map[ruleType] || `奖励 +${rule.flowers}`;
    }
}

module.exports = new RewardService();
