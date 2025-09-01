// backfilling.js

const pool = require("./db"); // Shared pool

async function backfillIpoDetails() {
  console.log("🔍 Checking for missing IPO records...");

  try {
    await pool.query("BEGIN");

    const query = `
      SELECT
          i.name AS ipo_name,
          i.details_ipo_id,
          i.url_rewrite
      FROM
          ipos i
      LEFT JOIN
          details_ipo d ON i.details_ipo_id = d.details_ipo_id
      WHERE
          d.details_ipo_id IS NULL;
    `;

    const { rows: recordsToInsert } = await pool.query(query);

    if (recordsToInsert.length === 0) {
      console.log("✅ No new records found. details_ipo is up to date.");
      await pool.query("COMMIT");
      return;
    }

    console.log(`📥 Found ${recordsToInsert.length} new records to insert.`);

    for (const record of recordsToInsert) {
      const insertQuery = `
        INSERT INTO details_ipo (ipo_name, details_ipo_id, url_rewrite)
        VALUES ($1, $2, $3)
        ON CONFLICT (details_ipo_id) DO NOTHING;
      `;
      const values = [record.ipo_name, record.details_ipo_id, record.url_rewrite];
      await pool.query(insertQuery, values);
      console.log(`   ➕ Inserted IPO: ${record.ipo_name}`);
    }

    await pool.query("COMMIT");
    console.log("🎉 All missing IPO details inserted successfully.");
  } catch (err) {
    await pool.query("ROLLBACK");
    console.error("❌ Backfill failed, rolled back transaction:", err.message);
  } finally {
    // 🔑 Clean shutdown
    await pool.end();
    process.exit(0);
  }
}

// run directly if called from CLI
if (require.main === module) {
  backfillIpoDetails();
}

module.exports = backfillIpoDetails;
