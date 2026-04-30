const { query, pool } = require('./db');

const createTableQuery = `
DROP TABLE IF EXISTS users CASCADE;
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash TEXT,
    google_id VARCHAR(100) UNIQUE,
    avatar_url TEXT,
    gold INTEGER DEFAULT 500,
    diamonds INTEGER DEFAULT 0,
    wins INTEGER DEFAULT 0,
    matches_played INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
`;

async function init() {
    try {
        console.log("Memulai inisialisasi database...");
        await query(createTableQuery);
        console.log("Table 'users' berhasil dibuat atau sudah ada.");
    } catch (err) {
        console.error("Gagal menginisialisasi database:", err.message);
        console.log("\n⚠️ PASTIKAN:");
        console.log("1. PostgreSQL sudah jalan.");
        console.log("2. Database 'suitclash' sudah dibuat.");
        console.log("3. Password di .env sudah benar.");
    } finally {
        await pool.end();
    }
}

init();
