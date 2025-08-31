const express = require("express");
const cors = require("cors");
const http = require("http");
const socketManager = require("../socketManager");
require("dotenv").config();
const cron = require("node-cron");
const ipoPool = require("../db"); // <-- Original IPO pool
const loginPool = require("../db_auth"); // <-- New login pool

const { syncIpos } = require("../controllers/IpoController");
const backfillIpoDetails = require("../backfilling");
const { DetailsIPO } = require("../controllers/DetailsIpoController");

const ipoRoutes = require("../routes/IpoRoutes");
const detailsIpoRoutes = require("../routes/DetailsIpoRoutes");
const authRoutes = require('../routes/authRoutes');

const app = express();
const port = process.env.PORT || 5000;
const server = http.createServer(app);

socketManager.init(server);

app.use(cors());
app.use(express.json());

app.use("/api/ipos", ipoRoutes);
app.use("/api/details-ipo", detailsIpoRoutes);
app.use("/api/auth", authRoutes);

app.get("/", (req, res) => {
  res.send("✅ IPO Backend running and connected to Neon DB");
});

server.listen(port, () => {
  console.log(`🚀 Server is running on http://localhost:${port}`);
});

// ------------------ HELPER: Wake DB ------------------
async function wakeDb(pool, name) {
  try {
    const result = await pool.query("SELECT 1");
    console.log(`🌙 ${name} DB is awake:`, result.rows);
    return true;
  } catch (err) {
    console.error(`⚠️ ${name} DB wake check failed:`, err.message);
    return false;
  }
}

// ------------------ CRON JOBS ------------------

// 🔹 New job to keep the Login DB awake
cron.schedule("*/10 * * * *", async () => {
  console.log("⏳ Starting Login DB wake-up call...");
  await wakeDb(loginPool, "Login");
});

// 🔹 Mainboard IPOs: every 15 minutes (GMP + subscription)
cron.schedule("*/15 * * * *", async () => {
  console.log("⏳ Starting Mainboard IPO sync...");

  const dbAwake = await wakeDb(ipoPool, "IPO");
  if (!dbAwake) {
    console.log("❌ Skipping Mainboard sync because DB is unavailable.");
    return;
  }

  await new Promise((res) => setTimeout(res, 2000));

  try {
    await syncIpos("mainboard", "live");
    await syncIpos("mainboard", "upcoming");
    await syncIpos("mainboard", "closed");

    console.log("✅ Mainboard IPO sync completed.");
  } catch (err) {
    console.error("❌ Mainboard cron failed:", err.message);
  }
});

// 🔹 SME IPOs: hourly, but only during market hours (10 AM–6 PM IST)
cron.schedule("0 * * * *", async () => {
  const now = new Date();
  const currentHourUTC = now.getUTCHours();

  // ✅ Market hours in UTC: 5 AM – 12 PM
  if (currentHourUTC < 5 || currentHourUTC > 12) {
    console.log("⏳ Skipping SME sync (outside market hours).");
    return;
  }

  console.log("⏳ Starting SME IPO sync...");

  const dbAwake = await wakeDb(ipoPool, "IPO");
  if (!dbAwake) {
    console.log("❌ Skipping SME sync because DB is unavailable.");
    return;
  }

  await new Promise((res) => setTimeout(res, 2000));

  try {
    await syncIpos("sme", "live");
    await syncIpos("sme", "upcoming");
    await syncIpos("sme", "closed");

    console.log("✅ SME sync completed.");
  } catch (err) {
    console.error("❌ SME cron failed:", err.message);
  }
});

// 🔹 Backfilling & Detailed IPOs: 3 times/day (8 AM, 2 PM, 8 PM UTC)
cron.schedule("0 8,14,20 * * *", async () => {
  console.log("⏳ Starting backfilling & details IPO sync...");

  const dbAwake = await wakeDb(ipoPool, "IPO");
  if (!dbAwake) {
    console.log("❌ Skipping backfilling because DB is unavailable.");
    return;
  }

  await new Promise((res) => setTimeout(res, 2000));

  try {
    await backfillIpoDetails();
    await DetailsIPO();

    console.log("✅ Backfilling & details IPO sync completed.");
  } catch (err) {
    console.error("❌ Backfilling cron failed:", err.message);
  }
});
