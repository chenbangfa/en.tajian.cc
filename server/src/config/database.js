const mysql = require('mysql2/promise');
const config = require('./index');

// 创建连接池
const pool = mysql.createPool(config.database);

// 测试连接
async function testConnection() {
    try {
        const connection = await pool.getConnection();
        console.log('✅ MySQL 数据库连接成功');
        connection.release();
        return true;
    } catch (error) {
        console.error('❌ MySQL 数据库连接失败:', error.message);
        return false;
    }
}

// 执行查询
// 使用 pool.query() 而非 pool.execute()，避免 mysql2 与 MySQL 8.x 之间
// Prepared Statement 协议的兼容问题（两者均支持参数化查询，安全性等价）
async function query(sql, params = []) {
    try {
        const [rows] = await pool.query(sql, params);
        return rows;
    } catch (error) {
        console.error('SQL执行错误:', error.message, '\nSQL:', sql);
        throw error;
    }
}

// 执行事务
async function transaction(callback) {
    const connection = await pool.getConnection();
    await connection.beginTransaction();

    try {
        const result = await callback(connection);
        await connection.commit();
        return result;
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

module.exports = {
    pool,
    query,
    transaction,
    testConnection
};
