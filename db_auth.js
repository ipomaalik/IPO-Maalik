const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.NEON_LOGIN_DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000, // add if you want to match db.js
  ssl: {
    rejectUnauthorized: false,
  },
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle client in Login DB:", err);
});

// Test connection on startup and release client properly
const connect = async () => {
  try {
    const client = await pool.connect();
    console.log("✅ Successfully connected to the Login DB.");
    client.release();
  } catch (err) {
    console.error("❌ Failed to connect to the Login DB:", err.message);
  }
};

connect();

module.exports = pool;
