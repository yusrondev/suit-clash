const { query, pool } = require('../db');

async function migrate() {
    try {
        console.log("Migrasi: Menambahkan kolom equipped asset...");
        await query(`
            ALTER TABLE users 
            ADD COLUMN IF NOT EXISTS equipped_background_id INTEGER REFERENCES shop_items(id) ON DELETE SET NULL,
            ADD COLUMN IF NOT EXISTS equipped_cardback_id INTEGER REFERENCES shop_items(id) ON DELETE SET NULL;
        `);
        console.log("Migrasi berhasil!");
    } catch (err) {
        console.error("Migrasi gagal:", err.message);
    } finally {
        await pool.end();
    }
}

migrate();
