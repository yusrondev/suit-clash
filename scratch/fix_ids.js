const db = require('../db');

async function fixExisting() {
  try {
    const users = await db.query("SELECT id FROM users");

    for (const user of users.rows) {
      const equippedItems = await db.query(`
        SELECT item_id 
        FROM user_inventory 
        WHERE user_id = $1 AND is_equipped = TRUE
      `, [user.id]);

      const ids = equippedItems.rows.map(r => r.item_id.toString());
      
      await db.query("UPDATE users SET equipped_emojis = $1 WHERE id = $2", [ids, user.id]);
      console.log(`Fixed user ${user.id} with IDs: ${ids.join(',')}`);
    }
    console.log("Fix complete.");
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

fixExisting();
