const db = require('../db');
async function checkItems() {
  try {
    const res = await db.query("SELECT id, name, price_gold, price_diamonds FROM shop_items");
    console.log("Shop Items:", res.rows);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
checkItems();
