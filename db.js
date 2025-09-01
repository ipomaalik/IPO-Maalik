// db.js
const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000, // ⏱️ 15 seconds
  ssl: {
    rejectUnauthorized: false,
  },
});


module.exports = pool;
