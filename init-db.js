const { query, pool } = require('./db');

const createTableQuery = `
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

DROP TABLE IF EXISTS user_inventory CASCADE;
DROP TABLE IF EXISTS shop_items CASCADE;

CREATE TABLE shop_items (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    type VARCHAR(20) DEFAULT 'emoticon',
    price_gold INTEGER DEFAULT 0,
    price_diamonds INTEGER DEFAULT 0,
    lottie_url TEXT NOT NULL,
    sound_url TEXT,
    additional_text VARCHAR(100),
    rarity VARCHAR(20) DEFAULT 'common',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE user_inventory (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    item_id INTEGER REFERENCES shop_items(id) ON DELETE CASCADE,
    is_equipped BOOLEAN DEFAULT FALSE,
    purchased_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, item_id)
);

-- Clear and Seed initial items
TRUNCATE shop_items CASCADE;
INSERT INTO shop_items (name, type, price_gold, price_diamonds, lottie_url, sound_url, additional_text, rarity)
VALUES 
('Laughing Cat', 'emoticon', 100, 0, '/assets/lottie/shop/common/cat-laughing.json', NULL, 'Hahaha!', 'common'),
('Sleepy Cat', 'emoticon', 150, 0, '/assets/lottie/shop/common/cat-sleep.json', NULL, 'Zzz...', 'common'),
('Cool Guy', 'emoticon', 0, 50, '/assets/lottie/shop/rare/cool.json', NULL, 'Stay Cool', 'rare'),
('Epic Music', 'emoticon', 500, 10, '/assets/lottie/shop/epic/music.json', '/assets/sounds/viral.mp3', 'VIRAL!', 'epic'),
('Legendary Recall', 'emoticon', 2000, 100, '/assets/lottie/shop/legendary/recall.json', '/assets/sounds/lightning.mp3', 'I AM BACK!', 'legendary'),
('King', 'emoticon', 50, 10, '/assets/lottie/shop/common/king.json', NULL, 'Belajar dulu dek!', 'common')
ON CONFLICT DO NOTHING;
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
