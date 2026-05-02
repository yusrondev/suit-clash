const db = require('../db');

async function grantToAll() {
  try {
    const freeItems = await db.query("SELECT id FROM shop_items WHERE price_gold = 0 AND price_diamonds = 0");
    const users = await db.query("SELECT id FROM users");

    for (const user of users.rows) {
      for (const item of freeItems.rows) {
        await db.query("INSERT INTO user_inventory (user_id, item_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [user.id, item.id]);
      }
      console.log(`Granted to user ${user.id}`);
    }
    console.log("Migration complete.");
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

grantToAll();
