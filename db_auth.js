// IPO_MAALIK_BE/db_auth.js
const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.NEON_LOGIN_DATABASE_URL,
  max: 5, // Capping concurrent connections
  idleTimeoutMillis: 30000, // Releasing idle connections after 30s
  ssl: {
    rejectUnauthorized: false, // needed for Neon
  },
});

// A helper function to check the connection
const connect = async () => {
  try {
    await pool.connect();
    console.log("✅ Successfully connected to the Login DB.");
  } catch (err) {
    console.error("❌ Failed to connect to the Login DB:", err.message);
  }
};

connect();

module.exports = pool;
