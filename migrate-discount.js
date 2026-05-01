const { query, pool } = require('./db');

async function migrate() {
    try {
        console.log("Menambahkan kolom original_price ke shop_items...");
        await query(`
            ALTER TABLE shop_items 
            ADD COLUMN IF NOT EXISTS original_price_gold INTEGER,
            ADD COLUMN IF NOT EXISTS original_price_diamonds INTEGER;
        `);
        
        // Contoh: Set diskon untuk King
        await query(`
            UPDATE shop_items 
            SET original_price_gold = 100, original_price_diamonds = 20 
            WHERE name = 'King';
        `);

        console.log("Migrasi berhasil!");
    } catch (err) {
        console.error("Migrasi gagal:", err.message);
    } finally {
        await pool.end();
    }
}

migrate();
