const db = require('../db');

async function seed() {
  try {
    const defaults = [
      { name: 'Angry', url: '/assets/lottie/angry.json', rarity: 'common' },
      { name: 'Cat', url: '/assets/lottie/cat.json', rarity: 'common' },
      { name: 'Monkey', url: '/assets/lottie/monkey.json', rarity: 'common' },
      { name: 'OK', url: '/assets/lottie/ok.json', rarity: 'common' }
    ];

    for (const item of defaults) {
      const check = await db.query("SELECT id FROM shop_items WHERE lottie_url = $1", [item.url]);
      if (check.rows.length === 0) {
        await db.query(
          "INSERT INTO shop_items (name, type, price_gold, price_diamonds, lottie_url, rarity) VALUES ($1, 'emoticon', 0, 0, $2, $3)",
          [item.name, item.url, item.rarity]
        );
        console.log(`Inserted ${item.name}`);
      } else {
        console.log(`${item.name} already exists`);
      }
    }
    console.log("Seeding complete.");
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

seed();
