// backfilling.js

/**
 * @file Synchronizes data from 'ipos' to 'details_ipo'.
 * Ensures missing IPOs in details_ipo are inserted.
 */

const pool = require("./db"); // Shared pool

async function backfillIpoDetails() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    console.log("Finding records in ipos table that are missing from details_ipo...");

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

    const result = await client.query(query);
    const recordsToInsert = result.rows;

    if (recordsToInsert.length === 0) {
      console.log("No new records found. The details_ipo table is up to date.");
      await client.query("COMMIT");
      return;
    }

    console.log(`Found ${recordsToInsert.length} new records to insert.`);

    for (const record of recordsToInsert) {
      const insertQuery = `
        INSERT INTO details_ipo (ipo_name, details_ipo_id, url_rewrite)
        VALUES ($1, $2, $3)
        ON CONFLICT (details_ipo_id) DO NOTHING;
      `;
      const values = [record.ipo_name, record.details_ipo_id, record.url_rewrite];
      await client.query(insertQuery, values);
      console.log(`Inserted details for IPO: ${record.ipo_name}`);
    }

    await client.query("COMMIT");
    console.log("All new IPO details have been successfully inserted.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(
      "An error occurred during backfilling. The transaction has been rolled back.",
      err
    );
  } finally {
    client.release(); // ✅ important to release back to pool
  }
}

module.exports = backfillIpoDetails;
