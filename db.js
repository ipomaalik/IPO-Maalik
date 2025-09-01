const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000, // 15 seconds timeout for connecting
  ssl: {
    rejectUnauthorized: false,
  },
});

// Handle unexpected errors on idle clients to prevent crashes
pool.on("error", (err) => {
  console.error("Unexpected error on idle client in IPO DB:", err);
});

module.exports = pool;
