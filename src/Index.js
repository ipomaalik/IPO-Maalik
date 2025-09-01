const express = require("express");
const cors = require("cors");
const http = require("http");
const socketManager = require("../socketManager");
require("dotenv").config();
const cron = require("node-cron");

const ipoPool = require("../db");
const loginPool = require("../db_auth");

const { syncIpos } = require("../controllers/IpoController");
const backfillIpoDetails = require("../backfilling");
const { DetailsIPO } = require("../controllers/DetailsIpoController");

const ipoRoutes = require("../routes/IpoRoutes");
const detailsIpoRoutes = require("../routes/DetailsIpoRoutes");
const authRoutes = require("../routes/authRoutes");

const app = express();
const port = process.env.PORT || 5000;
const server = http.createServer(app);

socketManager.init(server);

app.use(cors());
app.use(express.json());

app.use("/api/ipos", ipoRoutes);
app.use("/api/details-ipo", detailsIpoRoutes);
app.use("/api/auth", authRoutes);

// ---------- Base Route ----------
app.get("/", (req, res) => {
  res.send("✅ IPO Backend running and connected to Neon DB");
});

// ---------- DB Health Route (for uptime monitor) ----------
app.get("/health/db", async (req, res) => {
  try {
    const result = await ipoPool.query("SELECT 1");
    res.send("✅ IPO DB Alive");
  } catch (err) {
    res.status(500).send("❌ DB Error: " + err.message);
  }
});

server.listen(port, () => {
  console.log(`🚀 Server is running on http://localhost:${port}`);
});


// ------------------ HELPER: IST Logger ------------------
function logWithIST(message) {
  const now = new Date();
  const istTime = new Date(now.getTime() + (5 * 60 + 30) * 60000); // UTC + 5:30
  const timestamp = istTime.toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${timestamp} IST] ${message}`);
}


// ------------------ HELPER: Wake DB ------------------
async function wakeDb(pool, name) {
  try {
    const result = await pool.query("SELECT 1");
    logWithIST(`🌙 ${name} DB is awake: ${JSON.stringify(result.rows)}`);
    return true;
  } catch (err) {
    logWithIST(`⚠️ ${name} DB wake check failed: ${err.message}`);
    return false;
  }
}

// Retry wrapper
async function wakeDbWithRetry(pool, name, attempts = 3, delayMs = 5000) {
  for (let i = 1; i <= attempts; i++) {
    const success = await wakeDb(pool, name);
    if (success) return true;

    if (i < attempts) {
      logWithIST(`🔁 Retry #${i} for waking ${name} DB in ${delayMs / 1000}s...`);
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }
  return false;
}


// ------------------ CRON JOBS ------------------

// 🔹 Keep Login DB awake (every 10 min)
cron.schedule("*/10 * * * *", async () => {
  logWithIST("⏳ Login DB wake-up cron triggered...");
  await wakeDbWithRetry(loginPool, "Login");
});

// 🔹 Mainboard IPOs: every 15 minutes
cron.schedule("*/15 * * * *", async () => {
  logWithIST("⏳ Mainboard IPO sync cron triggered...");

  const dbAwake = await wakeDbWithRetry(ipoPool, "IPO");
  if (!dbAwake) {
    logWithIST("❌ Skipping Mainboard sync because DB is unavailable.");
    return;
  }

  await new Promise((res) => setTimeout(res, 2000));

  try {
    await syncIpos("mainboard", "live");
    await syncIpos("mainboard", "upcoming");
    await syncIpos("mainboard", "closed");
    logWithIST("✅ Mainboard IPO sync completed.");
  } catch (err) {
    logWithIST(`❌ Mainboard cron failed: ${err.message}`);
  }
});

// 🔹 SME IPOs: every 3 hours (only during 10 AM–6 PM IST)
cron.schedule("0 */3 * * *", async () => {
  const now = new Date();
  const currentHourUTC = now.getUTCHours();

  // ✅ Market hours in UTC: 5 AM – 12 PM
  if (currentHourUTC < 5 || currentHourUTC > 12) {
    logWithIST("⏳ Skipping SME sync (outside market hours).");
    return;
  }

  logWithIST("⏳ SME IPO sync cron triggered...");

  const dbAwake = await wakeDbWithRetry(ipoPool, "IPO");
  if (!dbAwake) {
    logWithIST("❌ Skipping SME sync because DB is unavailable.");
    return;
  }

  await new Promise((res) => setTimeout(res, 2000));

  try {
    await syncIpos("sme", "live");
    await syncIpos("sme", "upcoming");
    await syncIpos("sme", "closed");
    logWithIST("✅ SME sync completed.");
  } catch (err) {
    logWithIST(`❌ SME cron failed: ${err.message}`);
  }
});

// 🔹 Backfilling & Details IPOs: 3 times/day (8 AM, 2 PM, 8 PM UTC)
cron.schedule("0 11,14,18 * * *", async () => {
  logWithIST("⏳ Backfilling & details IPO cron triggered...");

  const dbAwake = await wakeDbWithRetry(ipoPool, "IPO");
  if (!dbAwake) {
    logWithIST("❌ Skipping backfilling because DB is unavailable.");
    return;
  }

  await new Promise((res) => setTimeout(res, 2000));

  try {
    await backfillIpoDetails();
    await DetailsIPO();
    logWithIST("✅ Backfilling & details IPO sync completed.");
  } catch (err) {
    logWithIST(`❌ Backfilling cron failed: ${err.message}`);
  }
});
