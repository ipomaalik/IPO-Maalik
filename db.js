// db.js
const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // from .env
  max: 5, // 👈 cap it to 5 (well below Neon’s 20 limit)
  idleTimeoutMillis: 30000, // release idle connections after 30s
  ssl: {
    rejectUnauthorized: false, // needed for Neon
  },
});

module.exports = pool;
