const db = require('../db');
async function run() {
  await db.query("UPDATE shop_items SET lottie_url = '/assets/images/shop/common/1777703825595-triangle_texture.jpg' WHERE id = 20");
  console.log("Updated ID 20");
  process.exit();
}
run();
