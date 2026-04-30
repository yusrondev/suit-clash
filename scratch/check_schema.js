const db = require('../db');
db.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'users'")
    .then(res => {
        console.log("Columns in 'users' table:");
        res.rows.forEach(row => console.log("- " + row.column_name));
        process.exit(0);
    })
    .catch(err => {
        console.error(err);
        process.exit(1);
    });
