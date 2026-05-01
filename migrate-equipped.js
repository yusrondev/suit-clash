const { query, pool } = require('./db');

async function migrate() {
    try {
        console.log("Menambahkan kolom equipped_emojis ke tabel users...");
        await query(`
            ALTER TABLE users 
            ADD COLUMN IF NOT EXISTS equipped_emojis TEXT[] DEFAULT '{}';
        `);
        console.log("Migrasi berhasil!");
    } catch (err) {
        console.error("Migrasi gagal:", err.message);
    } finally {
        await pool.end();
    }
}

migrate();
