-- Suit Clash Database Schema v1

-- 1. Users Table
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
    is_admin BOOLEAN DEFAULT FALSE,
    equipped_emojis TEXT[] DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Shop Items Table
CREATE TABLE IF NOT EXISTS shop_items (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    type VARCHAR(20) DEFAULT 'emoticon',
    price_gold INTEGER DEFAULT 0,
    price_diamonds INTEGER DEFAULT 0,
    original_price_gold INTEGER,
    original_price_diamonds INTEGER,
    lottie_url TEXT NOT NULL,
    sound_url TEXT,
    additional_text VARCHAR(100),
    rarity VARCHAR(20) DEFAULT 'common',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. User Inventory Table
CREATE TABLE IF NOT EXISTS user_inventory (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    item_id INTEGER REFERENCES shop_items(id) ON DELETE CASCADE,
    is_equipped BOOLEAN DEFAULT FALSE,
    purchased_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, item_id)
);
