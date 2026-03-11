
const bcrypt = require('bcrypt');
const path = require('path');
// Load environment variables from .env file explicitly
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { query, pool } = require('../src/config/database');

async function createAdmin() {
    try {
        console.log('🔄 Checking database connection...');
        // Test connection first
        const connection = await pool.getConnection();
        connection.release();
        console.log('✅ Database connected.');

        const username = 'admin';
        const rawPassword = 'bangfa'; // Updated password

        console.log(`🔐 Hashing password for user: ${username}`);
        const hashedPassword = await bcrypt.hash(rawPassword, 10);

        console.log('🔍 Checking if admin user exists...');
        const existing = await query('SELECT * FROM admin_users WHERE username = ?', [username]);

        if (existing.length > 0) {
            console.log('⚠️ User already exists, updating password...');
            await query('UPDATE admin_users SET password_hash = ?, is_active = 1 WHERE username = ?', [hashedPassword, username]);
            console.log('✅ Password updated successfully.');
        } else {
            console.log('🆕 User does not exist, creating new admin account...');
            await query(
                'INSERT INTO admin_users (username, password_hash, display_name, is_active) VALUES (?, ?, ?, 1)',
                [username, hashedPassword, 'Administrator']
            );
            console.log('✅ Admin account created successfully.');
        }

    } catch (error) {
        console.error('❌ Error creating/updating admin user:', error);
        process.exit(1);
    } finally {
        if (pool) {
            await pool.end();
            console.log('👋 Database connection pool closed.');
        }
        process.exit(0);
    }
}

createAdmin();
