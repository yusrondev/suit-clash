const { query, pool } = require('../db');

async function migrate() {
    try {
        console.log("Migrasi: Menambahkan kolom is_active ke shop_items...");
        await query(`
            ALTER TABLE shop_items 
            ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
        `);
        console.log("Migrasi berhasil!");
    } catch (err) {
        console.error("Migrasi gagal:", err.message);
    } finally {
        await pool.end();
    }
}

migrate();
