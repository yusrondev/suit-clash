require('dotenv').config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const path = require("path");
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── SECURITY HEADERS FOR GOOGLE AUTH ─────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  next();
});

// ── AUTH ENDPOINTS ───────────────────────────────────────────────────────────
app.post("/api/auth/register", async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ success: false, msg: "Data tidak lengkap." });

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await db.query(
      "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email, gold, diamonds, wins, matches_played",
      [username, email, passwordHash]
    );
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, msg: "Username atau Email sudah terdaftar." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await db.query("SELECT * FROM users WHERE email = $1", [email]);
    if (result.rows.length === 0) return res.status(401).json({ success: false, msg: "User tidak ditemukan." });

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ success: false, msg: "Password salah." });

    const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET);
    res.json({ 
      success: true, 
      token, 
      user: { id: user.id, username: user.username, gold: user.gold, diamonds: user.diamonds, wins: user.wins, matches_played: user.matches_played, avatar_url: user.avatar_url } 
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, msg: "Server error." });
  }
});

app.post("/api/auth/google", async (req, res) => {
  const { email, name, googleId, avatar } = req.body;
  if (!email || !googleId) return res.status(400).json({ success: false, msg: "Invalid Google data." });

  try {
    // 1. Cek apakah email sudah ada
    let result = await db.query("SELECT * FROM users WHERE email = $1", [email]);
    let user;

    if (result.rows.length > 0) {
      // 2. Jika sudah ada, update google_id dan avatar
      user = result.rows[0];
      const updateRes = await db.query(
        "UPDATE users SET google_id = $1, avatar_url = $2 WHERE id = $3 RETURNING id, username, email, gold, diamonds, wins, matches_played, avatar_url",
        [googleId, avatar, user.id]
      );
      user = updateRes.rows[0];
    } else {
      // 3. Jika belum ada, coba insert dengan username unik
      let finalUsername = name || email.split('@')[0];
      
      // Pastikan username tidak bentrok
      const nameCheck = await db.query("SELECT id FROM users WHERE username = $1", [finalUsername]);
      if (nameCheck.rows.length > 0) {
        finalUsername = finalUsername + Math.floor(Math.random() * 1000);
      }

      const insertRes = await db.query(
        `INSERT INTO users (username, email, google_id, avatar_url) 
         VALUES ($1, $2, $3, $4) 
         RETURNING id, username, email, gold, diamonds, wins, matches_played, avatar_url`,
        [finalUsername, email, googleId, avatar]
      );
      user = insertRes.rows[0];
    }

    const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET);
    res.json({ success: true, token, user });
  } catch (err) {
    console.error("GOOGLE AUTH ERROR:", err);
    res.status(500).json({ success: false, msg: "Google login failed: " + err.message });
  }
});

// ── SHOP & INVENTORY ENDPOINTS ────────────────────────────────────────────────
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, msg: "Token missing." });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ success: false, msg: "Token invalid." });
    req.user = user;
    next();
  });
};

app.get("/api/shop/items", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM shop_items ORDER BY rarity DESC, price_gold ASC");
    res.json({ success: true, items: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, msg: "Failed to fetch items." });
  }
});

app.get("/api/shop/defaults", async (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const lottieDir = path.join(__dirname, 'public', 'assets', 'lottie');
  
  try {
    const files = fs.readdirSync(lottieDir);
    const systemFiles = ['recall.json', 'win.json', 'target.json', 'lightning.json', 'fall-smoke.json'];
    const defaults = files
      .filter(f => f.endsWith('.json') && !systemFiles.includes(f))
      .map(f => ({
        id: f.replace('.json', ''),
        name: f.replace('.json', '').replace(/-/g, ' ').toUpperCase(),
        lottie_url: `/assets/lottie/${f}`,
        rarity: 'common',
        is_default: true
      }));
    res.json({ success: true, defaults });
  } catch (err) {
    res.status(500).json({ success: false, msg: "Failed to fetch default emojis." });
  }
});

app.post("/api/shop/buy", authenticateToken, async (req, res) => {
  const { itemId, currency } = req.body; // currency: 'gold' or 'diamonds'
  const userId = req.user.id;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // 1. Get item details
    const itemRes = await client.query("SELECT * FROM shop_items WHERE id = $1", [itemId]);
    if (itemRes.rows.length === 0) throw new Error("Item not found.");
    const item = itemRes.rows[0];

    // 2. Get user details (FOR UPDATE to lock the row and prevent race conditions)
    const userRes = await client.query("SELECT gold, diamonds FROM users WHERE id = $1 FOR UPDATE", [userId]);
    if (userRes.rows.length === 0) throw new Error("User not found.");
    const user = userRes.rows[0];

    // 3. Check if user already has it
    const ownRes = await client.query("SELECT id FROM user_inventory WHERE user_id = $1 AND item_id = $2", [userId, itemId]);
    if (ownRes.rows.length > 0) throw new Error("Anda sudah memiliki item ini.");

    // 4. Check balance and deduct
    let price = 0;
    if (currency === 'gold') {
      price = item.price_gold;
      if (user.gold < price) throw new Error("Gold tidak cukup.");
      await client.query("UPDATE users SET gold = gold - $1 WHERE id = $2", [price, userId]);
    } else if (currency === 'diamonds') {
      price = item.price_diamonds;
      if (user.diamonds < price) throw new Error("Diamond tidak cukup.");
      await client.query("UPDATE users SET diamonds = diamonds - $1 WHERE id = $2", [price, userId]);
    } else {
      throw new Error("Mata uang tidak valid.");
    }

    // 5. Add to inventory
    await client.query("INSERT INTO user_inventory (user_id, item_id) VALUES ($1, $2)", [userId, itemId]);

    await client.query('COMMIT');

    // Return updated stats
    const updatedUserRes = await db.query("SELECT gold, diamonds, wins, matches_played, avatar_url FROM users WHERE id = $1", [userId]);
    res.json({ success: true, msg: "Pembelian berhasil!", user: updatedUserRes.rows[0], price: price });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.json({ success: false, msg: err.message || "Pembelian gagal." });
  } finally {
    client.release();
  }
});

app.get("/api/user/stats", authenticateToken, async (req, res) => {
  try {
    const result = await db.query("SELECT gold, diamonds, wins, matches_played FROM users WHERE id = $1", [req.user.id]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, msg: "User not found." });
    res.json({ success: true, stats: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, msg: "Server error." });
  }
});

app.get("/api/user/inventory", authenticateToken, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT i.*, s.name, s.type, s.lottie_url, s.sound_url, s.additional_text, s.rarity 
      FROM user_inventory i 
      JOIN shop_items s ON i.item_id = s.id 
      WHERE i.user_id = $1
    `, [req.user.id]);

    const userRes = await db.query("SELECT equipped_emojis FROM users WHERE id = $1", [req.user.id]);
    const equipped = userRes.rows[0].equipped_emojis || [];

    res.json({ 
      success: true, 
      inventory: result.rows,
      equipped_emojis: equipped
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, msg: "Failed to fetch inventory." });
  }
});

app.post("/api/user/inventory/toggle-equip", authenticateToken, async (req, res) => {
  const { itemId } = req.body;
  const userId = req.user.id;
  const itemIdStr = itemId.toString();

  try {
    // Get current equipped list
    const userRes = await db.query("SELECT equipped_emojis FROM users WHERE id = $1", [userId]);
    let equipped = userRes.rows[0].equipped_emojis || [];

    const index = equipped.indexOf(itemIdStr);
    if (index > -1) {
      // Unequip
      if (equipped.length <= 1) {
        return res.json({ success: false, msg: "Minimal harus ada 1 emoji!" });
      }
      equipped.splice(index, 1);
    } else {
      // Equip
      if (equipped.length >= 10) {
        return res.json({ success: false, msg: "Maksimal 10 emoji di menu!" });
      }
      equipped.push(itemIdStr);
    }

    await db.query("UPDATE users SET equipped_emojis = $1 WHERE id = $2", [equipped, userId]);
    res.json({ success: true, equipped_emojis: equipped });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, msg: "Gagal mengubah status equipment." });
  }
});

app.post("/api/user/equip", authenticateToken, async (req, res) => {
  const { itemId } = req.body;
  const userId = req.user.id;

  try {
    // Unequip all items of the same type (currently only 'emoticon')
    const itemTypeRes = await db.query("SELECT type FROM shop_items WHERE id = $1", [itemId]);
    if (itemTypeRes.rows.length === 0) return res.status(404).json({ success: false, msg: "Item not found." });
    const type = itemTypeRes.rows[0].type;

    await db.query(`
      UPDATE user_inventory 
      SET is_equipped = FALSE 
      WHERE user_id = $1 AND item_id IN (SELECT id FROM shop_items WHERE type = $2)
    `, [userId, type]);

    // Equip the new one
    await db.query("UPDATE user_inventory SET is_equipped = TRUE WHERE user_id = $1 AND item_id = $2", [userId, itemId]);

    res.json({ success: true, msg: "Item equipped!" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, msg: "Failed to equip item." });
  }
});

// ── DECK ──────────────────────────────────────────────────────────────────────
const suits = ["♠", "♥", "♦", "♣"];
const values = [
  "A",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
];

function getRank(v) {
  if (v === "A") return 14;
  if (v === "K") return 13;
  if (v === "Q") return 12;
  if (v === "J") return 11;
  return parseInt(v);
}

const CARDS_EACH = 4;
const DEFAULT_INITIAL_CARDS = 4;

function createDeck() {
  const d = [];
  suits.forEach((s) => values.forEach((v) => d.push({ value: v, suit: s })));
  return d.sort(() => Math.random() - 0.5);
}

// ── ROOMS ─────────────────────────────────────────────────────────────────────
// rooms: Map<roomId, GameState>
const rooms = new Map();
const disconnectTimers = new Map();

function makeGame() {
  return {
    players: [], // [{id, name, cards}]
    deck: [],
    tableCard: null,
    currentSuit: null,
    currentPlayer: 0,

    controllerPlayer: null,
    controllerCard: null,
    freeMode: false,

    roundCards: [],
    outOrder: [], // urutan pemain keluar
    tableHistory: [], // Persistent history of cards played
    playersPlayed: new Set(),
    skipPlayer: null,

    started: false,
    leaderboard: {}, // 🔥 per-room leaderboard
    roundCount: 0,
    maxRounds: 7, // 🔥 NEW: Dinamis dari Host
    initialCards: DEFAULT_INITIAL_CARDS, // 🔥 NEW: Dinamis dari Host
    tableColor: 'green', // 🔥 NEW: Warna meja pilihan Host
    nextStarter: null,
    lastTakerProvider: null, // Tracks who played the card that was just taken
  };
}

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;

// ── BOT AI ────────────────────────────────────────────────────────────────────
const BOT_ID = '__bot__';

function isBotTurn(game) {
  const cur = game.players[game.currentPlayer];
  return cur && cur.isBot;
}

function scheduleBotTurn(game, roomId) {
  if (!game || !game.started) return;
  if (!isBotTurn(game)) return;

  // Jeda acak 1.2s - 2.4s supaya terasa alami
  const delay = 1200 + Math.random() * 1200;
  setTimeout(() => {
    if (!game.started) return;
    if (!isBotTurn(game)) return;
    runBotTurn(game, roomId);
  }, delay);
}

function runBotTurn(game, roomId) {
  const botIndex = game.currentPlayer;
  const bot = game.players[botIndex];
  if (!bot || !bot.isBot) return;

  const isFree = game.freeMode && game.controllerPlayer === botIndex;

  // ── Cari kartu yang bisa dimainkan ──
  let playableCards;
  if (isFree) {
    playableCards = bot.cards.map((c, i) => ({ c, i })); // bisa pakai kartu apa saja
  } else {
    playableCards = bot.cards
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.suit === game.currentSuit);
  }

  // ── Strategi Bot ──
  if (playableCards.length > 0) {
    // Pilih kartu tertinggi jika free mode, terendah jika bukan
    playableCards.sort((a, b) => {
      const ra = getRank(a.c.value);
      const rb = getRank(b.c.value);
      return isFree ? rb - ra : ra - rb; // free: mainkan tinggi dulu, biasa: rendah dulu
    });

    const chosen = playableCards[0];
    const card = bot.cards.splice(chosen.i, 1)[0];

    if (isFree) {
      game.currentSuit = card.suit;
      game.tableCard = card;
      game.tableHistory.push(card);
      game.controllerCard = { player: botIndex, card };
      game.freeMode = false;
      game.skipPlayer = botIndex;

      io.to(roomId).emit('botAction', { action: 'play', botName: bot.name, card });
      if (checkEnd(game, roomId)) return;
      nextTurn(game, roomId);
    } else {
      if (!game.controllerCard || getRank(card.value) > getRank(game.controllerCard.card.value)) {
        game.controllerPlayer = botIndex;
        game.controllerCard = { player: botIndex, card };
      }
      game.roundCards.push({ player: botIndex, card });
      game.playersPlayed.add(botIndex);
      game.tableCard = card;
      game.tableHistory.push(card);

      io.to(roomId).emit('botAction', { action: 'play', botName: bot.name, card });
      if (checkEnd(game, roomId)) return;
      nextTurn(game, roomId);
    }
    return;
  }

  // ── Tidak ada kartu cocok: ambil dari deck terus sampai dapat yang cocok ──
  if (game.deck.length > 0) {
    const drawn = game.deck.pop();
    bot.cards.push(drawn);
    io.to(roomId).emit('botAction', { action: 'draw', botName: bot.name });
    sendState(game);

    const canPlayDrawn = isFree || drawn.suit === game.currentSuit;
    if (canPlayDrawn) {
      // Dapat kartu cocok — langsung main setelah jeda kecil
      setTimeout(() => runBotTurn(game, roomId), 900);
    } else if (game.deck.length > 0) {
      // Masih ada deck, coba ambil lagi setelah jeda
      setTimeout(() => runBotTurn(game, roomId), 800);
    } else {
      // Deck habis, coba ambil dari meja
      if (game.tableHistory.length > 0 && !game.freeMode) {
        io.to(roomId).emit('botAction', { action: 'takeTable', botName: bot.name });
        resolveTableTake(game, botIndex, roomId);
      } else {
        game.playersPlayed.add(botIndex);
        if (checkEnd(game, roomId)) return;
        nextTurn(game, roomId);
      }
    }
    return;
  }

  // ── Deck habis: ambil dari meja ──
  if (game.tableHistory.length > 0 && !game.freeMode) {
    io.to(roomId).emit('botAction', { action: 'takeTable', botName: bot.name });
    resolveTableTake(game, botIndex, roomId);
    return;
  }

  // Fallback: tidak bisa apa-apa, skip ronde
  game.playersPlayed.add(botIndex);
  nextTurn(game, roomId);
}

function resolveTableTake(game, pIndex, roomId) {
  const p = game.players[pIndex];
  if (!game.tableHistory || game.tableHistory.length === 0) {
    // 🔥 Jika deck kosong & meja kosong, terpaksa skip ronde ini
    console.log(`[${roomId}] ${p.name} skip karena deck & meja kosong`);
    game.playersPlayed.add(pIndex);
    if (checkEnd(game, roomId)) return;
    nextTurn(game, roomId);
    return;
  }

  const takenCard = game.tableHistory.pop();
  if (!takenCard) return;
  p.cards.push(takenCard);

  // Identify who played this card to track potential winner if round ends
  // Identify who played this card to track potential winner if round ends
  let playedBy = -1;
  if (game.controllerCard && game.controllerCard.card.suit === takenCard.suit && game.controllerCard.card.value === takenCard.value) {
    playedBy = game.controllerCard.player;
    // 🔥 TUNTUTAN USER: Jangan hapus controllerCard agar dia tetap dianggap pemenang 
    // jika tidak ada yang mengeluarkan kartu lebih tinggi.
  } else {
    const rcIndex = game.roundCards.findIndex(rc => rc.card.suit === takenCard.suit && rc.card.value === takenCard.value);
    if (rcIndex !== -1) {
      playedBy = game.roundCards[rcIndex].player;
      // 🔥 TUNTUTAN USER: Jangan hapus dari roundCards agar tetap masuk hitungan 'highest'
    }
  }

  if (playedBy !== -1) {
    game.lastTakerProvider = playedBy;
  }

  // Mark this player as "played" for this round
  game.playersPlayed.add(pIndex);

  // Update Table Visual
  if (game.tableHistory.length > 0) {
    game.tableCard = game.tableHistory[game.tableHistory.length - 1];
  } else {
    game.tableCard = null;
  }

  const msg = `${p.name}${p.isBot ? ' (Bot)' : ''} mengambil kartu meja.`;
  io.to(roomId).emit('toast', { msg });

  // 🔥 TUNTUTAN USER (FIXED): Jangan langsung resolveRound.
  // Gunakan nextTurn agar giliran berlanjut ke pemain C, D dst.
  // Ronde akan otomatis berakhir via nextTurn jika semua sudah played/take.
  nextTurn(game, roomId);
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
async function updateUserStats(dbId, winsDelta = 0, matchesDelta = 0) {
  if (!dbId) return;
  try {
    const result = await db.query(
      "UPDATE users SET wins = wins + $1, matches_played = matches_played + $2, gold = gold + ($1 * 100) WHERE id = $3 RETURNING gold, diamonds, wins, matches_played",
      [winsDelta, matchesDelta, dbId]
    );
    // Find socket associated with this dbId if possible, or handle via separate emit
    return result.rows[0];
  } catch (err) {
    console.error("Gagal update user stats:", err);
  }
}

function isActive(game, i) {
  const p = game.players[i];
  if (!p || p.isOut) return false;
  if (p.cards.length === 0) return false; // Pemain tanpa kartu tidak aktif
  return true;
}

function isPlayerStuck(game, pIndex) {
  const p = game.players[pIndex];
  if (!isActive(game, pIndex)) return false;

  // Jika freeMode dan dia controller, wajib main (tidak stuck)
  if (game.freeMode && game.controllerPlayer === pIndex) return false;

  // Jika punya kartu cocok, tidak stuck
  const hasSuit = p.cards.some((c) => c.suit === game.currentSuit);
  if (hasSuit) return false;

  // Jika deck masih ada, bisa ambil (tidak stuck)
  if (game.deck.length > 0) return false;

  // Jika meja masih ada kartu, bisa ambil (tidak stuck)
  if (game.tableHistory && game.tableHistory.length > 0) return false;

  return true;
}

function sendState(game) {
  game.players.forEach((p, i) => {
    if (p.isBot) return; // Bot tidak punya socket, skip
    io.to(p.id).emit("state", {
      yourCards: p.cards,
      tableCard: game.tableCard,
      currentSuit: game.currentSuit,
      currentPlayer: game.currentPlayer,
      yourIndex: i,
      controller: game.controllerPlayer,
      skip: game.skipPlayer,
      deckCount: game.deck.length,
      totalPlayers: game.players.length,
      playersCardCount: game.players.map((pl) => pl.cards.length),
      playerNames: game.players.map((pl) => pl.name),
      playersIsOut: game.players.map((pl) => pl.isOut),
      roundCards: game.roundCards,
      tableHistory: game.tableHistory || [],
      freeMode: game.freeMode,
      started: game.started,
      playersIsOffline: game.players.map((pl) => !!pl.isOffline),
      roundCount: game.roundCount,
      maxRounds: game.maxRounds,
      tableColor: game.tableColor || 'green',
      attackCharges: game.players.map(pl => pl.attackCharges),
      playersMicStatus: game.players.map(pl => !!pl.micStatus),
      playerIds: game.players.map(pl => pl.id),
      matchStartTime: game.matchStartTime,
      initialCards: game.initialCards || DEFAULT_INITIAL_CARDS,
      serverTime: Date.now(),
    });
  });
}

function checkEnd(game, roomId) {
  let someoneOut = false;

  game.players.forEach((p, i) => {
    if (p.cards.length === 0 && !p.isOut) {
      p.isOut = true;
      someoneOut = true;

      // Tandai sebagai sudah "main" di ronde ini agar tidak ditunggu lagi
      game.playersPlayed.add(i);

      game.outOrder.push(i); // 🔥 simpan urutan keluar
      if (game.outOrder.length === 1) {
        game.nextStarter = i;
      }

      console.log(`${p.name} keluar dari ronde`);

      io.to(roomId).emit("playerOut", {
        name: p.name,
      });

      // Wins are now handled at the end of the entire match based on overall points ranking.
    }
  });

  const activePlayers = game.players.filter((p) => !p.isOut);

  // kalau tinggal 1 → dia kalah
  if (activePlayers.length === 1) {
    const loserIndex = game.players.findIndex(p => !p.isOut);
    const loser = game.players[loserIndex];

    console.log(`Game selesai! ${loser.name} kalah`);

    // 🔥 Kirim state terakhir agar kartu terakhir terlihat di meja sebelum overlay muncul
    sendState(game);

    // 🔥 TUNTUTAN USER: Kasih jeda sebelum alert/overlay win muncul (1.5 detik)
    setTimeout(async () => {
        // 🔥 HITUNG POIN BERDASARKAN URUTAN
        const pointsTable = [10, 7, 5, 3]; // bisa adjust

        game.outOrder.forEach((playerIndex, rank) => {
          const player = game.players[playerIndex];
          const point = pointsTable[rank] || 1;

          if (!game.leaderboard[player.name]) {
            game.leaderboard[player.name] = { win: 0, lose: 0, point: 0 };
          }

          game.leaderboard[player.name].win += 1;
          game.leaderboard[player.name].point += point;
        });

        // ❌ loser
        if (!game.leaderboard[loser.name]) {
          game.leaderboard[loser.name] = { win: 0, lose: 0, point: 0 };
        }
        game.leaderboard[loser.name].lose += 1;

        const isMatchEnd = game.roundCount >= game.maxRounds;

        io.to(roomId).emit("gameOver", {
          loserName: loser.name,
          isMatchEnd: isMatchEnd,
        });

        game.started = false;

        // 🔥 TUNTUTAN USER (FIXED): Update Total Pertandingan (matches_played) & Menang (wins)
        if (isMatchEnd) {
          // 1. Find the overall winner (Rank 1 by points)
          let overallWinnerName = null;
          let maxPoints = -1;
          Object.entries(game.leaderboard).forEach(([name, data]) => {
            if (data.point > maxPoints) {
              maxPoints = data.point;
              overallWinnerName = name;
            }
          });

          // 2. Update stats for each player
          game.players.forEach(async (p) => {
            if (p.dbId && !p.isBot) {
              const isWinner = (p.name === overallWinnerName);
              const winsDelta = isWinner ? 1 : 0;
              const matchesDelta = 1;

              const newStats = await updateUserStats(p.dbId, winsDelta, matchesDelta);
              if (newStats && p.id) {
                io.to(p.id).emit("sync-stats", newStats);
              }
            }
          });
        }
    }, 1500);

    return true;
  }

  return false;
}

function nextTurn(game, roomId) {
  // Pemain yang harus main: aktif (tidak out), bukan skipPlayer
  const activePlayers = game.players
    .map((_, i) => i)
    .filter((i) => isActive(game, i) && i !== game.skipPlayer);

  // Pemain yang masih belum main di ronde ini (aktif & belum played)
  const stillNeedToPlay = activePlayers.filter(
    (i) => !game.playersPlayed.has(i)
  );

  if (stillNeedToPlay.length === 0) {
    sendState(game);
    resolveRound(game, roomId);
    return;
  }

  // Cari giliran berikutnya
  let next = game.currentPlayer;
  let attempts = 0;
  do {
    next = (next + 1) % game.players.length;
    attempts++;
    if (attempts > game.players.length) {
      sendState(game);
      resolveRound(game, roomId);
      return;
    }
  } while (
    !isActive(game, next) ||
    game.playersPlayed.has(next) ||
    next === game.skipPlayer
  );

  // 🔥 CEK APAKAH PEMAIN TERJEBAK (STUCK)
  if (isPlayerStuck(game, next)) {
    console.log(`[${roomId}] ${game.players[next].name} auto-skip (stuck: no cards to match/draw/take)`);
    game.playersPlayed.add(next);
    
    // Kirim notifikasi ke UI
    io.to(roomId).emit("toast", { msg: `${game.players[next].name} dilewati karena kartu habis / tidak cocok.` });
    
    // Lanjut cari pemain berikutnya secara rekursif
    nextTurn(game, roomId);
    return;
  }

  game.currentPlayer = next;
  sendState(game);
  scheduleBotTurn(game, game._roomId);
}

function resolveRound(game, roomId) {
  let highest = game.controllerCard;

  game.roundCards.forEach((r) => {
    if (!highest || getRank(r.card.value) > getRank(highest.card.value)) {
      highest = r;
    }
  });

  let winnerIndex;
  if (highest) {
    winnerIndex = highest.player;
  } else if (game.lastTakerProvider !== null && game.lastTakerProvider !== undefined) {
    winnerIndex = game.lastTakerProvider;
  } else {
    // Fallback: This should only happen if everyone took the very first card of the match
    winnerIndex = game.controllerPlayer !== null ? game.controllerPlayer : 0;
  }

  // Reset tracker
  game.lastTakerProvider = null;

  // Emit event to clear the table before resetting state
  io.to(roomId).emit("roundResolved", {
    winner: winnerIndex,
    winnerName:
      game.players[winnerIndex]?.name || "Pemain " + (winnerIndex + 1),
    roundCards: game.roundCards,
  });

  // Wins are now handled in checkEnd for the overall match winner (Rank 1)

  game.roundCards = [];
  game.tableHistory = []; // 🔥 Bersihkan meja setelah ronde selesai
  game.playersPlayed.clear();
  game.skipPlayer = null;
  game.controllerCard = null;
  game.currentSuit = null;

  // Jika pemenang ronde sudah isOut (kartu habis = menang), cari pemain aktif berikutnya
  let nextController = winnerIndex;
  if (!isActive(game, winnerIndex)) {
    let attempts = 0;
    do {
      nextController = (nextController + 1) % game.players.length;
      attempts++;
      if (attempts > game.players.length) {
        nextController = winnerIndex; // fallback, seharusnya tidak terjadi
        break;
      }
    } while (!isActive(game, nextController));
  }

  game.controllerPlayer = nextController;
  game.currentPlayer = nextController;
  game.freeMode = true;

  // Short delay before sending next state so clients can show the clear animation
  setTimeout(() => {
    sendState(game);
    scheduleBotTurn(game, game._roomId);
  }, 500);
}

function startGame(game) {
  if (game.roundCount === 0) {
    game.leaderboard = {};
  }
  game.matchStartTime = Date.now(); // Reset timer every round

  game.deck = createDeck();
  game.players.forEach((p, playerIdx) => {
    p.cards = [];
    p.isOut = false;
    p.attackCharges = {}; 
    
    // Initialize charges for each opponent
    game.players.forEach((_, targetIdx) => {
      if (targetIdx !== playerIdx) {
        p.attackCharges[targetIdx] = 2;
      }
    });

    console.log(`[Game] Initialized attackCharges for ${p.name} (idx ${playerIdx}):`, p.attackCharges);

    for (let k = 0; k < (game.initialCards || CARDS_EACH); k++) {
      p.cards.push(game.deck.pop());
    }
  });

  game.tableCard = game.deck.pop();
  game.tableHistory = [game.tableCard]; // Start with the first card
  game.currentSuit = game.tableCard.suit;
  game.roundCount++;

  if (game.nextStarter !== null && game.players[game.nextStarter]) {
    game.currentPlayer = game.nextStarter;
    console.log(`[Game Start] Ronde ${game.roundCount}: Pemenang sebelumnya ${game.players[game.currentPlayer].name} mulai duluan.`);
    game.nextStarter = null; // reset
  } else {
    // FALLBACK: Kartu Tertinggi (untuk Ronde 1)
    let highestVal = -1;
    let highestSuitIdx = 4; // ♠=0, ♥=1, ♦=2, ♣=3

    game.players.forEach((p, i) => {
      p.cards.forEach((c) => {
        const val = getRank(c.value);
        const sIdx = suits.indexOf(c.suit);
        if (val > highestVal || (val === highestVal && sIdx < highestSuitIdx)) {
          highestVal = val;
          highestSuitIdx = sIdx;
          game.currentPlayer = i;
        }
      });
    });
    console.log(`[Game Start] Ronde ${game.roundCount}: Kartu Tertinggi: ${suits[highestSuitIdx]}${highestVal} milik ${game.players[game.currentPlayer].name}`);
  }

  game.controllerPlayer = null;
  game.controllerCard = null;
  game.freeMode = false;
  game.roundCards = [];
  game.outOrder = [];
  game.playersPlayed.clear();
  game.skipPlayer = null;
  game.lastTakerProvider = null;
  game.started = true;
}

// ── SOCKET ────────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  socket.on('ping_lat', (callback) => {
    if (typeof callback === 'function') callback();
  });
  let currentRoom = null;
  let playerIndex = -1;
  let userId = null;

  socket.on("auth", async (token) => {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      userId = decoded.id;
      // Sync stats from DB
      const result = await db.query("SELECT gold, diamonds, wins, matches_played FROM users WHERE id = $1", [userId]);
      if (result.rows[0]) {
        socket.emit("sync-stats", result.rows[0]);
      }
      console.log(`[Socket] Authenticated user ID: ${userId}`);

      // If already in a room, update the player object with dbId
      if (currentRoom) {
        const game = rooms.get(currentRoom);
        if (game) {
          const p = game.players.find(pl => pl.id === socket.id);
          if (p) p.dbId = userId;
        }
      }
    } catch (err) {
      // console.log("Auth failed for socket", socket.id);
    }
  });

  // Helper to handle player leaving a room (immediate or with grace period)
  const handlePlayerLeave = (roomId, isImmediate = false) => {
    if (!roomId) return;
    const game = rooms.get(roomId);
    if (!game) return;

    const pIndex = game.players.findIndex((pl) => pl.id === socket.id);
    if (pIndex === -1) return;

    const p = game.players[pIndex];
    const name = p.name;

    if (isImmediate) {
      if (game.started) {
        // Match in progress: DO NOT splice (it breaks all indices). 
        // Just mark offline and decouple socket.
        p.isOffline = true;
        p.id = null;
        console.log(`[${roomId}] ${name} left during active game. Keeping ghost seat.`);
      } else {
        game.players.splice(pIndex, 1);
        console.log(`[${roomId}] ${name} left lobby.`);
      }

      // Only reset to lobby if the room becomes empty
      if (game.players.length === 0 || game.players.every(pl => pl.isOffline && !pl.id)) {
        game.started = false; 
        rooms.delete(roomId);
        console.log(`[${roomId}] Room dihapus (kosong)`);
      } else {
        io.to(roomId).emit("playerLeft", { name });
        sendState(game);
      }
    } else {
      p.isOffline = true;
      io.to(roomId).emit("playerStatus", { index: pIndex, status: 'offline' });
      sendState(game); 
      console.log(`[${roomId}] ${name} disconnected. Starting 20s grace period...`);

      const timerKey = roomId + "|" + name;
      const timer = setTimeout(() => {
        const gameNow = rooms.get(roomId);
        if (!gameNow) return;
        if (p.isOffline) {
          if (!gameNow.started) {
            // Only safe to remove if game hasn't started
            gameNow.players = gameNow.players.filter((pl) => pl !== p);
          } else {
            // In game: just leave as offline ghost
            p.id = null; 
          }

          // If no one is left online
          if (gameNow.players.length === 0 || gameNow.players.every(pl => pl.isOffline && !pl.id)) {
             gameNow.started = false;
             rooms.delete(roomId);
          } else {
            io.to(roomId).emit("playerLeft", { name });
            sendState(gameNow);
          }
        }
        disconnectTimers.delete(timerKey);
      }, 20000);
      disconnectTimers.set(timerKey, timer);
    }
  };

  // ── JOIN WITH BOT (1v1) ──
  socket.on("joinWithBot", ({ name }) => {
    if (currentRoom) handlePlayerLeave(currentRoom, true);
    // Buat room unik per sesi
    const roomId = 'bot_' + socket.id.slice(0, 8);
    currentRoom = roomId;

    if (!rooms.has(roomId)) rooms.set(roomId, makeGame());
    const game = rooms.get(roomId);
    game._roomId = roomId;

    socket.join(roomId);
    playerIndex = 0;

    // Tambah pemain manusia
    game.players.push({
      id: socket.id,
      name: name || 'Pemain',
      cards: [],
      isOut: false,
      isBot: false,
      dbId: userId, // Store DB ID for stats tracking
      attackCharges: {},
      micStatus: false
    });

    // Tambah bot
    const botNames = ['Ada', 'Eva', 'Max', 'Rex', 'Neo'];
    const botName = botNames[Math.floor(Math.random() * botNames.length)] + ' 🤖';
    game.players.push({
      id: BOT_ID,
      name: botName,
      cards: [],
      isOut: false,
      isBot: true,
      attackCharges: {},
      micStatus: false
    });

    console.log(`[${roomId}] ${name} vs Bot (${botName}) — Game dimulai!`);

    startGame(game);
    sendState(game);

    // Schedule bot turn jika bot duluan
    scheduleBotTurn(game, roomId);
  });

  // ── JOIN ROOM ──
  socket.on("joinRoom", ({ name, room }) => {
    const roomId = (room || "default").trim().toLowerCase();
    const cleanName = (name || "").trim();
    if (currentRoom && currentRoom !== roomId) handlePlayerLeave(currentRoom, true);
    currentRoom = roomId;

    if (!rooms.has(roomId)) rooms.set(roomId, makeGame());
    const game = rooms.get(roomId);
    game._roomId = roomId;

    // 1. Check if player is reconnecting first (by name, case-insensitive and trimmed)
    const timerKey = roomId + "|" + cleanName;
    const existingPlayer = game.players.find(p => p.name.trim().toLowerCase() === cleanName.toLowerCase());
    
    if (existingPlayer) {
      // 🔥 TUNTUTAN USER: Cek jika nama sudah ada dan pemain tersebut sedang ONLINE
      // Jika id berbeda dan sedang online, berarti ada orang lain yang pakai nama ini
      if (!existingPlayer.isOffline && existingPlayer.id !== socket.id) {
        socket.emit("errorMsg", {
          msg: "Nama ini sudah digunakan oleh pemain lain di room ini. Silakan gunakan nama lain."
        });
        return;
      }

      console.log(`[${roomId}] ${cleanName} re-joining (Socket: ${socket.id.slice(0,5)}). Resuming seat ${game.players.indexOf(existingPlayer)}...`);
      existingPlayer.id = socket.id;
      existingPlayer.isOffline = false;
      playerIndex = game.players.indexOf(existingPlayer);
      
      const timer = disconnectTimers.get(timerKey);
      if (timer) {
        clearTimeout(timer);
        disconnectTimers.delete(timerKey);
      }
      
      socket.join(roomId);
      currentRoom = roomId;
      
      io.to(roomId).emit("playerStatus", { 
        index: playerIndex, 
        status: 'online' 
      });
      
      sendState(game);
      return;
    }

    console.log(`[${roomId}] ${cleanName} attempting to join as new player...`);

    // 2. If not reconnecting and game is in progress, reject
    if (game.started) {
      socket.emit("errorMsg", {
        msg: "Game sedang berlangsung, coba room lain.",
      });
      return;
    }

    // If room is full, reject
    if (game.players.length >= MAX_PLAYERS) {
      socket.emit("errorMsg", {
        msg: `Room ${roomId} sudah penuh (maks 4 pemain).`,
      });
      return;
    }

    socket.join(roomId);

    playerIndex = game.players.length;
    game.players.push({
      id: socket.id,
      name: cleanName || "Pemain " + (playerIndex + 1),
      cards: [],
      isOut: false,
      dbId: userId, // Store DB ID for stats tracking
      attackCharges: {}, // { targetIndex: charges }
      micStatus: false
    });

    console.log(
      `[${roomId}] ${cleanName} bergabung (${game.players.length}/${MAX_PLAYERS})`,
    );

    // Notify others
    socket.to(roomId).emit("playerJoined", { name: cleanName });

    // ALWAYS send state so indices (who is host) are synced
    sendState(game);

    if (game.players.length < MIN_PLAYERS) {
      socket.emit("waitingForPlayers", { count: game.players.length });
    }
  });

  socket.on("checkRoom", ({ room }) => {
    const roomId = (room || "default").trim().toLowerCase();
    const game = rooms.get(roomId);
    if (!game) {
      socket.emit("roomInfo", { exists: false });
    } else {
      socket.emit("roomInfo", { 
        exists: true, 
        hostName: game.players[0] ? game.players[0].name : "Unknown",
        playerCount: game.players.length,
        started: game.started
      });
    }
  });

  socket.on("kickPlayer", ({ targetIndex }) => {
    if (!currentRoom) return;
    const game = rooms.get(currentRoom);
    if (!game || game.started) return;

    // Only host (index 0) can kick
    if (game.players[0].id !== socket.id) return;

    const target = game.players[targetIndex];
    if (!target || target.isBot || targetIndex === 0) return;

    console.log(`[${currentRoom}] Host kicking ${target.name}`);

    // Notify the target
    io.to(target.id).emit("kicked");

    // Remove from room
    game.players.splice(targetIndex, 1);
    
    // Broadcast leave
    io.to(currentRoom).emit("playerLeft", { name: target.name });

    // Send state to everyone
    sendState(game);
  });

  socket.on("getLeaderboard", () => {
    const game = rooms.get(currentRoom);
    // ✅ TUNTUTAN USER: Hanya tampilkan pemain yang sedang ada di room ini (biar gak global/nyampur)
    const currentNames = game.players.map(p => p.name);
    
    const sorted = Object.entries(game.leaderboard)
      .filter(([name]) => currentNames.includes(name))
      .map(([name, data]) => ({
        name,
        win: data.win,
        lose: data.lose,
        point: data.point,
      }))
      .sort((a, b) => b.point - a.point);

    socket.emit("leaderboardData", sorted);
  });

  socket.on("setTableColor", (color) => {
    const game = rooms.get(currentRoom);
    if (!game) return;
    const isHost = game.players.findIndex(p => p.id === socket.id) === 0;
    if (!isHost) return;
    game.tableColor = color;
    sendState(game);
  });

  socket.on("setMaxRounds", (rounds) => {
    if (!currentRoom) return;
    const game = rooms.get(currentRoom);
    if (!game || game.started) return;

    // Hanya host (index 0) yang bisa ubah
    if (game.players[0].id !== socket.id) return;

    const r = parseInt(rounds);
    if (r >= 1 && r <= 20) {
      game.maxRounds = r;
      sendState(game);
    }
  });

  socket.on("setInitialCards", (count) => {
    if (!currentRoom) return;
    const game = rooms.get(currentRoom);
    if (!game || game.started) return;

    // Hanya host (index 0) yang bisa ubah
    if (game.players[0].id !== socket.id) return;

    const c = parseInt(count);
    if (c >= 1 && c <= 15) {
      game.initialCards = c;
      sendState(game);
    }
  });

  socket.on("takeTableCard", () => {
    if (!currentRoom) return;
    const game = rooms.get(currentRoom);
    if (!game || !game.started) return;

    // ✅ TUNTUTAN USER: Pastikan meja memang ada kartunya sebelum diolah
    if (!game.tableHistory || game.tableHistory.length === 0) {
      return;
    }

    const pIndex = game.players.findIndex((p) => p.id === socket.id);
    if (game.currentPlayer !== pIndex) {
      console.log(`[${currentRoom}] Unauthorized: ${socket.id} mencoba ambil kartu meja padahal bukan gilirannya!`);
      return;
    }

    console.log(`[${currentRoom}] ${game.players[pIndex].name} mencoba ambil kartu meja. freeMode: ${game.freeMode}, currentSuit: ${game.currentSuit}`);

    // ✅ TUNTUTAN USER: Gak boleh ambil kalau lagi freeMode (dia pemimpin round)
    if (game.freeMode) {
      socket.emit("errorMsg", { msg: "Anda adalah pemimpin putaran, wajib mengeluarkan kartu." });
      return;
    }

    // ✅ TUNTUTAN USER: Gak boleh ambil kalau punya kartu yang cocok (suit sama)
    const p = game.players[pIndex];
    if (game.currentSuit) {
        const hasSuit = p.cards.some((c) => c.suit === game.currentSuit);
        if (hasSuit) {
            socket.emit("errorMsg", { msg: "Anda punya kartu yang cocok, silakan keluarkan kartu." });
            return;
        }
    }

    if (game.deck.length > 0) {
      socket.emit("errorMsg", { msg: "Deck masih ada kartu, silakan ambil dari deck dulu." });
      return;
    }

    resolveTableTake(game, pIndex, currentRoom);
  });

  socket.on("sendEmoji", (data) => {
    if (!currentRoom) return;

    const game = rooms.get(currentRoom);
    if (!game) return;

    const player = game.players.find(p => p.id === socket.id);
    if (!player) return;

    io.to(currentRoom).emit("emoji", {
      name: player.name,
      emoji: data.emoji,
      text: data.text,
      lottieUrl: data.lottieUrl,
      soundUrl: data.soundUrl
    });
  });

  socket.on("attackPlayer", ({ targetIndex }) => {
    if (!currentRoom) return;
    const game = rooms.get(currentRoom);
    if (!game || !game.started) return;

    const attackerIndex = game.players.findIndex(p => p.id === socket.id);
    if (attackerIndex === -1) return;

    const attacker = game.players[attackerIndex];
    if (!attacker.attackCharges || (attacker.attackCharges[targetIndex] || 0) <= 0) {
      socket.emit("errorMsg", { msg: "Jatah serangan ke pemain ini habis!" });
      return;
    }

    const target = game.players[targetIndex];
    if (!target) return;

    attacker.attackCharges[targetIndex]--;
    
    // Broadcast attack event
    io.to(currentRoom).emit("playerAttacked", {
      attackerIndex,
      targetIndex,
      attackerName: attacker.name,
      targetName: target.name
    });

    // Also update state to sync charges (optional, but good for UI)
    sendState(game);
  });

  socket.on("chat", (msg) => {
    if (!currentRoom) return;

    const game = rooms.get(currentRoom);
    if (!game) return;

    const p = game.players.find(pl => pl.id === socket.id);
    if (!p) return;

    io.to(currentRoom).emit("chat", {
      name: p.name,
      msg
    });
  });

  socket.on("peekCard", (data) => {
    if (!currentRoom) return;
    const game = rooms.get(currentRoom);
    if (!game) return;
    const pIdx = game.players.findIndex(p => p.id === socket.id);
    if (pIdx === -1) return;
    const card = (data.index !== null && game.players[pIdx].cards[data.index]) ? game.players[pIdx].cards[data.index] : null;
    socket.to(currentRoom).emit("peekState", { 
      playerIndex: pIdx, 
      cardIndex: data.index, 
      card: card 
    });
  });

  // ── START GAME (Manual) ──
  socket.on("startGame", () => {
    if (!currentRoom) return;
    const game = rooms.get(currentRoom);
    if (!game || game.started) return;

    // Host is game.players[0]
    if (game.players[0].id !== socket.id) {
      console.log(
        `[${currentRoom}] Rejek startGame: Pemain id ${socket.id} bukan host.`,
      );
      socket.emit("errorMsg", {
        msg: "Hanya host yang bisa memulai permainan.",
      });
      return;
    }

    if (game.players.length < MIN_PLAYERS) {
      console.log(
        `[${currentRoom}] Rejek startGame: Pemain kurang (${game.players.length}/${MIN_PLAYERS}).`,
      );
      socket.emit("errorMsg", {
        msg: `Butuh minimal ${MIN_PLAYERS} pemain untuk memulai.`,
      });
      return;
    }

    startGame(game);
    sendState(game);
    console.log(`[${currentRoom}] Game dimulai secara manual oleh Host`);
  });

// ── PLAY CARD ──
  socket.on("playCard", ({ index, cardId }) => {
    if (!currentRoom) return;
    const game = rooms.get(currentRoom);
    if (!game || !game.started) return;

    const i = game.players.findIndex((p) => p.id === socket.id);
    if (i !== game.currentPlayer) return;
    if (!isActive(game, i)) return;

    const player = game.players[i];

    // Cari kartu berdasarkan cardId (value|suit) untuk hindari race condition index
    let resolvedIndex = index;
    if (cardId) {
      const [cv, cs] = cardId.split('|');
      const found = player.cards.findIndex(c => c.value === cv && c.suit === cs);
      if (found !== -1) resolvedIndex = found;
    }

    const card = player.cards[resolvedIndex];
    if (!card) return;

    // CONTROLLER FREE PLAY
    if (game.freeMode && i === game.controllerPlayer) {
      player.cards.splice(resolvedIndex, 1);

      game.currentSuit = card.suit;
      game.tableCard = card;
      game.tableHistory.push(card);

      game.controllerCard = { player: i, card };
      game.freeMode = false;
      game.skipPlayer = i;

      if (checkEnd(game, currentRoom)) return;
      nextTurn(game, currentRoom);
      return;
    }

    // INVALID SUIT
    if (card.suit !== game.currentSuit) return;

    player.cards.splice(resolvedIndex, 1);

    // ✅ TUNTUTAN USER: Cek apakah kartu baru lebih tinggi dari kartu tertinggi di meja
    if (!game.controllerCard || getRank(card.value) > getRank(game.controllerCard.card.value)) {
      game.controllerPlayer = i;
      game.controllerCard = { player: i, card };
    }

    game.roundCards.push({ player: i, card });
    game.playersPlayed.add(i);
    game.tableCard = card;
    game.tableHistory.push(card);

    if (checkEnd(game, currentRoom)) return;
    nextTurn(game, currentRoom);
  });

  // ── DRAW CARD ──
  socket.on("drawCard", () => {
    if (!currentRoom) return;
    const game = rooms.get(currentRoom);
    if (!game || !game.started) return;

    const i = game.players.findIndex((p) => p.id === socket.id);
    if (i !== game.currentPlayer) return;

    const p = game.players[i];

    // ✅ TUNTUTAN USER: Pemimpin tidak boleh ambil kartu (baik dari deck maupun meja)
    if (game.freeMode) {
      socket.emit("errorMsg", { msg: "Anda adalah pemimpin putaran, wajib mengeluarkan kartu." });
      return;
    }

    if (game.currentSuit) {
        const hasSuit = p.cards.some((c) => c.suit === game.currentSuit);
        if (hasSuit) {
          socket.emit("errorMsg", { msg: "Anda punya kartu yang cocok, silakan keluarkan kartu." });
          return;
        }
    }

    // ✅ Normal draw dari deck
    if (game.deck.length > 0) {
      p.cards.push(game.deck.pop());
      sendState(game);
      return;
    }

    resolveTableTake(game, i, currentRoom);
  });


  // ── RESTART ──
  socket.on("restartGame", () => {
    if (!currentRoom) return;
    const game = rooms.get(currentRoom);
    if (!game) return;

    // ✅ CEK HOST
    if (game.players[0].id !== socket.id) {
      socket.emit("errorMsg", {
        msg: "Hanya host yang bisa memulai ulang permainan.",
      });
      return;
    }

    if (game.players.length < MIN_PLAYERS) return;

    // 🔥 NEW: Reset Match jika sudah selesai atau diset paksa oleh logic ini
    const isMatchEnd = game.roundCount >= game.maxRounds || game.roundCount === 0;
    
    if (isMatchEnd) {
        console.log(`[${currentRoom}] 🔥 MATCH RESETTING: Round hit ${game.roundCount}/${game.maxRounds}. Starting new session.`);
        game.roundCount = 0; // startGame akan increment jadi 1
        game.leaderboard = {};
        io.to(currentRoom).emit("leaderboardData", []);
    } else {
        console.log(`[${currentRoom}] Continuing Match: Round ${game.roundCount}/${game.maxRounds} -> ${game.roundCount + 1}/${game.maxRounds}`);
    }

    startGame(game);
    sendState(game);
    scheduleBotTurn(game, currentRoom); 

    console.log(`[${currentRoom}] Game di-restart oleh HOST (Ronde: ${game.roundCount})`);
  });

  socket.on("backToLobby", () => {
    if (!currentRoom) return;
    const game = rooms.get(currentRoom);
    if (!game) return;

    // Only host can go back to lobby
    if (game.players[0].id !== socket.id) return;

    // Stop game and reset round count
    game.started = false;
    game.roundCount = 0;
    
    // Broadcast state so players see the lobby
    sendState(game);
    console.log(`[${currentRoom}] Host kembali ke lobby.`);
  });

  socket.on("leaveRoom", () => {
    if (currentRoom) {
      handlePlayerLeave(currentRoom, true);
      currentRoom = null;
    }
  });

  socket.on("voice-signal", (data) => {
    if (data.to) {
      io.to(data.to).emit("voice-signal", {
        from: socket.id,
        signal: data.signal
      });
    } else if (currentRoom) {
      // Broadcast ke semua orang di room tersebut (kecuali pengirim)
      socket.to(currentRoom).emit("voice-signal", {
        from: socket.id,
        signal: data.signal
      });
    }
  });

  socket.on("update-mic-status", (isOn) => {
    if (currentRoom) {
      const game = rooms.get(currentRoom);
      if (!game) return;
      const i = game.players.findIndex(p => p.id === socket.id);
      if (i !== -1) {
        game.players[i].micStatus = isOn;
        // Broadcast to update UI on all clients
        io.to(currentRoom).emit("mic-status-updated", { index: i, isOn });
      }
    }
  });

  // ── DISCONNECT ──
  socket.on("disconnect", () => {
    if (currentRoom) {
      handlePlayerLeave(currentRoom, false);
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});