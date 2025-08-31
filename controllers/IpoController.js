const pool = require("../db");
const axios = require("axios");
const cheerio = require("cheerio");
const socketManager = require("../socketManager");

// --- START: IST Date Helpers ---
/**
 * Add 5hr 30min to a UTC date string to get IST date as YYYY-MM-DD.
 */
function parseToISTDate(dateStr) {
  if (!dateStr) return null;
  try {
    const cleanStr = stripHtml(dateStr).trim();
    const date = new Date(cleanStr);
    if (isNaN(date.getTime())) return null;
    const istDate = new Date(date.getTime() + 19800000); // 5h30m offset
    return `${istDate.getFullYear()}-${("0" + (istDate.getMonth() + 1)).slice(-2)}-${(
      "0" + istDate.getDate()
    ).slice(-2)}`;
  } catch {
    return null;
  }
}
// --- END: IST Date Helpers ---

function stripHtml(s = "") {
  return s.replace(/<[^>]*>/g, "").trim();
}

/**
 * Formats an IPO name for use in ipopremium.in URLs.
 */
function formatNameForUrl(name) {
  if (!name) return "";
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, "-")
    .trim();
}

/**
 * Normalize an IPO name for consistent comparison across sources.
 */
function standardizeName(name) {
  if (!name) return "";
  let cleanName = name;

  // Remove content in parentheses
  cleanName = cleanName.replace(/\([^)]*\)/g, "").trim();

  // Normalize Unicode and replace apostrophes
  cleanName = cleanName.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  cleanName = cleanName.replace(/['’‘`]/g, "");

  // Replace ampersands and special characters with a single space
  cleanName = cleanName.replace(/&/g, " and ");
  cleanName = cleanName.replace(/[^a-zA-Z0-9 ]+/g, " ");

  const termsToRemove = [
    "ipo",
    "ltd",
    "limited",
    "pvt",
    "private",
    "co",
    "nse",
    "sme",
    "bse",
    "mainboard",
    "reit",
    "trust",
    "india",
  ];
  const regexPattern = new RegExp(`\\b(${termsToRemove.join("|")})\\b`, "gi");
  cleanName = cleanName.replace(regexPattern, "");

  return cleanName.replace(/\s+/g, " ").toLowerCase().trim();
}

/**
 * Extract the plain company name from Chittorgarh "Company" HTML cell.
 */
function extractNameFromChittorgarhCompany(htmlString) {
  const match = htmlString.match(/>([^<]+)</);
  return match ? match[1] : null;
}

function isDateString(value) {
  if (!value) return false;
  if (typeof value !== "string") return false;
  return /[0-9]/.test(value) && (/[a-zA-Z]/.test(value) || /[-\\/]/.test(value));
}

function isDateSet(value) {
  return (
    value !== null &&
    value !== undefined &&
    value !== "" &&
    String(value).toLowerCase() !== "n/a"
  );
}

function normalizeValueForCompare(value) {
  if (value === null || value === undefined) return null;
  if (!isNaN(value) && value !== "") return Number(value);
  if (typeof value === "string") {
    const d = parseToISTDate(value);
    if (d) return d;
    return value.trim();
  }
  if (value instanceof Date) return parseToISTDate(value);
  return value;
}

function areValuesEqual(val1, val2) {
  const v1 = normalizeValueForCompare(val1);
  const v2 = normalizeValueForCompare(val2);
  return v1 === v2;
}

/**
 * Build Chittorgarh API URL dynamically.
 */
function getChittorgarhApiUrl(category) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0 = Jan
  let financialYearStart = year;
  let financialYearEnd = year + 1;

  if (month < 3) {
    financialYearStart = year - 1;
    financialYearEnd = year;
  }

  const financialYearStr = `${financialYearStart}-${String(financialYearEnd).slice(-2)}`;
  const version = Math.floor(now.getTime() / 1000);

  const categoryId = category === "sme" ? "83" : "82";
  const baseUrl = `https://webnodejs.chittorgarh.com/cloud/report/data-read/${categoryId}/1/8`;
  const path = `${year}/${financialYearStr}/0/all/0`;
  const query = `?search=&v=${version}`;

  return `${baseUrl}/${path}${query}`;
}

async function getChittorgarhIpoData(category) {
  const chittorgarhApiUrl = getChittorgarhApiUrl(category);
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
  };
  try {
    const { data } = await axios.get(chittorgarhApiUrl, { headers });
    const ipos = data.reportTableData || [];

    const ipoMap = {};
    for (const ipo of ipos) {
      const name = extractNameFromChittorgarhCompany(ipo.Company);
      const companyHtml = ipo.Company;

      if (name && companyHtml) {
        const urlMatch = companyHtml.match(/\/ipo\/(.*?)\/(\d+)\//);

        if (urlMatch) {
          const urlRewrite = urlMatch[1];
          const chittorgarhId = urlMatch[2];
          const standardizedName = standardizeName(name);

          const listingAt = ipo["Listing at"]?.toLowerCase() || "";
          const isSme = listingAt.includes("sme");

          ipoMap[standardizedName] = {
            chittorgarhId,
            urlRewrite,
            priceBand: ipo["Issue Price (Rs.)"] || null,
            issueSize:
              ipo["Total Issue Amount (Incl.Firm reservations) (Rs.cr.)"] || null,
            listingAt,
            isSme,
          };
        }
      }
    }
    return ipoMap;
  } catch (err) {
    console.error("❌ Error fetching data from Chittorgarh:", err.message);
    return {};
  }
}

/**
 * ————————————————————————————————————————————————————————————————
 * Transaction-safe UPSERT (uses provided client, no socket emit inside)
 * Returns: { updated: boolean, eventPayload?: object, logs?: string[] }
 * ————————————————————————————————————————————————————————————————
 */
async function upsertIpoTx(
  client,
  rawIpo,
  detailsIpoId,
  newUrlRewrite,
  matchedDb,
  newCategory
) {
  const logs = [];
  const newName = stripHtml(rawIpo.name);
  const newStatus = rawIpo.current_status?.toUpperCase() || null;
  const newPriceBand = rawIpo.price || null;
  const newOpenDate = isDateString(rawIpo.open) ? parseToISTDate(rawIpo.open) : null;
  const newCloseDate = isDateString(rawIpo.close) ? parseToISTDate(rawIpo.close) : null;
  const newAllotmentDate = isDateString(rawIpo.allotment_date)
    ? parseToISTDate(rawIpo.allotment_date)
    : null;
  const newListingDate = isDateString(rawIpo.listing_date)
    ? parseToISTDate(rawIpo.listing_date)
    : null;
  const newImageUrl = rawIpo.icon_url || null;
  const newGmp = rawIpo.premium ? stripHtml(rawIpo.premium) : null;
  let newSubscription = rawIpo.subscription;

  // Subscription scrape (outside DB)
  if (newStatus === "OPEN" && rawIpo.id && newName) {
    try {
      const formattedName = formatNameForUrl(newName);
      const scrapeUrl = `https://www.ipopremium.in/view/ipo/${rawIpo.id}/${formattedName}`;
      const { data: pageHtml } = await axios.get(scrapeUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        },
      });

      const $ = cheerio.load(pageHtml);
      let scrapedSubscription = null;

      const totalHeader = $("b")
        .filter(function () {
          return $(this).text().trim() === "Total";
        })
        .first();

      if (totalHeader.length) {
        const subscriptionValue = totalHeader
          .closest("tr")
          .find("td:last-child b")
          .text()
          .trim();
        if (subscriptionValue && !isNaN(parseFloat(subscriptionValue))) {
          scrapedSubscription = subscriptionValue;
        }
      }

      if (scrapedSubscription) {
        newSubscription = scrapedSubscription;
      }
    } catch (scrapeError) {
      logs.push(
        `⚠️ Could not scrape subscription for "${newName}". ${scrapeError.message}`
      );
    }
  }

  // Fallback to DB value if needed
  if (
    newSubscription === null ||
    newSubscription === undefined ||
    newSubscription === "" ||
    (typeof newSubscription === "string" && newSubscription.toLowerCase() === "n/a")
  ) {
    newSubscription = matchedDb?.subscription || null;
  }

  // INSERT
  if (!matchedDb) {
    const query = `
      INSERT INTO ipos 
        (id, name, category, details_ipo_id, url_rewrite, status, subscription, gmp, price_band,
         offer_start_date, offer_end_date, image_url, allotment_date, listing_date)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    `;
    const values = [
      rawIpo.id,
      newName,
      newCategory,
      detailsIpoId,
      newUrlRewrite,
      newStatus,
      newSubscription,
      newGmp,
      newPriceBand,
      newOpenDate,
      newCloseDate,
      newImageUrl,
      newAllotmentDate,
      newListingDate,
    ];
    await client.query(query, values);

    logs.push(`✅ NEW IPO INSERTED: "${newName}" (ID: ${rawIpo.id})`);

    const eventPayload = {
      id: rawIpo.id,
      name: newName,
      subscription: newSubscription,
      gmp: newGmp,
      priceBand: newPriceBand,
      imageUrl: newImageUrl,
    };

    return { updated: true, eventPayload, logs };
  }

  // UPDATE
  const matchedId = matchedDb.id;
  const existingDetailsIpoId = matchedDb.details_ipo_id;
  const existingUrlRewrite = matchedDb.url_rewrite;
  const existingOpenDate = parseToISTDate(matchedDb.offer_start_date);
  const existingCloseDate = parseToISTDate(matchedDb.offer_end_date);
  const existingAllotmentDate = parseToISTDate(matchedDb.allotment_date);
  const existingListingDate = parseToISTDate(matchedDb.listing_date);

  const changedFields = [];

  if (!areValuesEqual(matchedDb.category, newCategory)) {
    changedFields.push({ name: "category", oldValue: matchedDb.category, newValue: newCategory });
  }
  if (!existingUrlRewrite && newUrlRewrite) {
    changedFields.push({
      name: "url_rewrite",
      oldValue: existingUrlRewrite,
      newValue: newUrlRewrite,
    });
  }
  if (!areValuesEqual(existingDetailsIpoId, detailsIpoId) && detailsIpoId) {
    changedFields.push({
      name: "details_ipo_id",
      oldValue: existingDetailsIpoId,
      newValue: detailsIpoId,
    });
  }
  if (!areValuesEqual(matchedDb.name, newName)) {
    changedFields.push({ name: "name", oldValue: matchedDb.name, newValue: newName });
  }
  if (!areValuesEqual(matchedDb.status, newStatus)) {
    changedFields.push({ name: "status", oldValue: matchedDb.status, newValue: newStatus });
  }
  if (!areValuesEqual(matchedDb.subscription, newSubscription)) {
    changedFields.push({
      name: "subscription",
      oldValue: matchedDb.subscription,
      newValue: newSubscription,
    });
  }
  if (!areValuesEqual(matchedDb.gmp, newGmp)) {
    changedFields.push({ name: "gmp", oldValue: matchedDb.gmp, newValue: newGmp });
  }
  if (!areValuesEqual(matchedDb.price_band, newPriceBand)) {
    changedFields.push({
      name: "price_band",
      oldValue: matchedDb.price_band,
      newValue: newPriceBand,
    });
  }
  if (!isDateSet(matchedDb.offer_start_date) && !areValuesEqual(existingOpenDate, newOpenDate)) {
    changedFields.push({
      name: "offer_start_date",
      oldValue: existingOpenDate,
      newValue: newOpenDate,
    });
  }
  if (!isDateSet(matchedDb.offer_end_date) && !areValuesEqual(existingCloseDate, newCloseDate)) {
    changedFields.push({
      name: "offer_end_date",
      oldValue: existingCloseDate,
      newValue: newCloseDate,
    });
  }
  if (
    !isDateSet(matchedDb.allotment_date) &&
    !areValuesEqual(existingAllotmentDate, newAllotmentDate)
  ) {
    changedFields.push({
      name: "allotment_date",
      oldValue: existingAllotmentDate,
      newValue: newAllotmentDate,
    });
  }
  if (!isDateSet(matchedDb.listing_date) && !areValuesEqual(existingListingDate, newListingDate)) {
    changedFields.push({
      name: "listing_date",
      oldValue: existingListingDate,
      newValue: newListingDate,
    });
  }
  if (!areValuesEqual(matchedDb.image_url, newImageUrl)) {
    changedFields.push({
      name: "image_url",
      oldValue: matchedDb.image_url,
      newValue: newImageUrl,
    });
  }

  if (changedFields.length > 0) {
    const updateClauses = changedFields.map((field, idx) => `${field.name} = $${idx + 2}`).join(", ");
    const updateValues = changedFields.map((field) => field.newValue);
    await client.query(`UPDATE ipos SET ${updateClauses} WHERE id = $1`, [
      matchedId,
      ...updateValues,
    ]);

    logs.push(`✨ IPO UPDATED: "${newName}" (ID: ${matchedId})`);
    changedFields.forEach((f) => {
      if (f.name === "subscription") {
        logs.push(
          `\tFIELD "subscription": "${f.oldValue}" → "${f.newValue}" (Updated from scrape)`
        );
      } else {
        logs.push(`\tFIELD "${f.name}": "${f.oldValue}" → "${f.newValue}"`);
      }
    });

    const eventPayload = {
      id: matchedId,
      name: newName,
      subscription: newSubscription,
      gmp: newGmp,
      priceBand: newPriceBand,
      imageUrl: newImageUrl,
    };

    return { updated: true, eventPayload, logs };
  }

  return { updated: false, logs };
}

/**
 * Batch sync with a single transaction per (category, status).
 * If anything fails, rollback the whole batch and emit nothing.
 */
async function syncIpos(category, status) {
  const client = await pool.connect();
  const eventsToEmit = []; // buffer socket events until COMMIT
  const logsToPrint = [];

  try {
    const params = {
      draw: "2",
      start: "0",
      length: "1000",
      "search[value]": "",
      "search[regex]": "false",
      all: "true",
      upcoming_ipos: "false",
      open_ipos: "false",
      closed_ipos: "false",
      _: Date.now(),
    };
    params.eq = category === "mainboard" ? "true" : "false";
    params.sme = category === "sme" ? "true" : "false";
    if (status === "upcoming") params.upcoming_ipos = "true";
    else if (status === "live") params.open_ipos = "true";
    else if (status === "closed") params.closed_ipos = "true";

    const { data } = await axios.get("https://www.ipopremium.in/ipo", {
      params,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        Accept: "application/json, text/plain, */*",
        Referer: "https://www.ipopremium.in/ipo",
        "X-Requested-With": "XMLHttpRequest",
      },
    });

    const rows = data?.data || [];
    if (!Array.isArray(rows)) {
      console.error("❌ Unexpected API response format");
      return 0;
    }

    const mainboardChittorgarhMap = await getChittorgarhIpoData("mainboard");
    const smeChittorgarhMap = await getChittorgarhIpoData("sme");
    const chittorgarhMap = { ...mainboardChittorgarhMap, ...smeChittorgarhMap };

    // Load DB state once
    const dbRows = await pool.query(
      "SELECT id, name, category, details_ipo_id, url_rewrite, status, subscription, gmp, price_band, offer_start_date, offer_end_date, image_url, allotment_date, listing_date FROM ipos"
    );
    const dbNameIdMap = new Map();
    for (const row of dbRows.rows) {
      const stdName = standardizeName(row.name);
      dbNameIdMap.set(stdName, row);
    }

    // Begin batch transaction
    await client.query("BEGIN");

    let updatedCount = 0;
    const cutOffDate = new Date("2025-01-01");

    for (const ipo of rows) {
      if (!ipo.open) continue;
      const offerStartDate = new Date(ipo.open);
      if (offerStartDate < cutOffDate) continue;

      const rawIpoPremiumName = stripHtml(ipo.name);
      const standardizedName = standardizeName(rawIpoPremiumName);

      const chittorgarhMatch = chittorgarhMap[standardizedName];
      const detailsIpoId = chittorgarhMatch ? chittorgarhMatch.chittorgarhId : null;
      const urlRewrite = chittorgarhMatch ? chittorgarhMatch.urlRewrite : null;
      const matchedDb = dbNameIdMap.get(standardizedName);

      // Determine category based on Chittorgarh data
      let newCategory = matchedDb?.category || "mainboard";
      if (chittorgarhMatch && chittorgarhMatch.isSme) {
        newCategory = "sme";
      }

      // Upsert within the active transaction
      const { updated, eventPayload, logs } = await upsertIpoTx(
        client,
        ipo,
        detailsIpoId,
        urlRewrite,
        matchedDb,
        newCategory
      );

      if (logs?.length) logsToPrint.push(...logs);
      if (updated) {
        updatedCount++;
        if (eventPayload) eventsToEmit.push(eventPayload);
      }
    }

    // Commit the whole batch
    await client.query("COMMIT");

    // Emit *after* commit
    if (eventsToEmit.length > 0) {
      const io = socketManager.getIO();
      for (const payload of eventsToEmit) {
        io.emit("ipoUpdate", payload);
      }
    }

    // Print logs (post-commit to avoid noise on rollback)
    if (logsToPrint.length) {
      logsToPrint.forEach((l) => console.log(l));
    }

    console.log(
      `✅ ${updatedCount} ${category.toUpperCase()} | ${status.toUpperCase()} IPOs inserted or updated.`
    );
    return updatedCount;
  } catch (err) {
    // Roll back entire batch if anything failed
    try {
      await client.query("ROLLBACK");
    } catch (rbErr) {
      console.error("⚠️ Rollback failed:", rbErr.message);
    }
    console.error(`❌ Error syncing ${category} / ${status} IPOs:`, err.message);
    return 0;
  } finally {
    client.release();
  }
}

async function getIposFromDb(req, res) {
  try {
    const { status, category } = req.query;
    let query =
      "SELECT *, allotment_date, listing_date, offer_start_date, offer_end_date FROM ipos WHERE 1=1";
    const values = [];
    let paramIndex = 1;

    if (category) {
      if (Array.isArray(category)) {
        const placeholders = category.map((_, i) => `$${paramIndex + i}`).join(",");
        query += ` AND category IN (${placeholders})`;
        values.push(...category);
        paramIndex += category.length;
      } else {
        query += ` AND category = $${paramIndex}`;
        values.push(category);
        paramIndex++;
      }
    }

    query += " ORDER BY id DESC";
    const result = await pool.query(query, values);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const ipos = result.rows.map((ipo) => {
      const allotmentDate = ipo.allotment_date ? new Date(ipo.allotment_date) : null;
      if (allotmentDate) allotmentDate.setHours(0, 0, 0, 0);
      const openDate = ipo.offer_start_date ? new Date(ipo.offer_start_date) : null;
      if (openDate) openDate.setHours(0, 0, 0, 0);
      const closeDate = ipo.offer_end_date ? new Date(ipo.offer_end_date) : null;
      if (closeDate) closeDate.setHours(0, 0, 0, 0);

      let currentStatus;
      if (openDate && today < openDate) currentStatus = "UPCOMING";
      else if (openDate && today >= openDate && closeDate && today <= closeDate)
        currentStatus = "LIVE";
      else if (closeDate && today > closeDate && allotmentDate && today <= allotmentDate)
        currentStatus = "ALLOTMENT PENDING";
      else if (allotmentDate && today > allotmentDate) currentStatus = "CLOSED";
      else currentStatus = ipo.status;

      return {
        id: ipo.id,
        name: ipo.name,
        details_ipo_id: ipo.details_ipo_id,
        url_rewrite: ipo.url_rewrite,
        imageUrl: ipo.image_url,
        priceBand: ipo.price_band,
        gmp: ipo.gmp,
        openDate: ipo.offer_start_date,
        closeDate: ipo.offer_end_date,
        offerDateRange:
          ipo.offer_start_date && ipo.offer_end_date
            ? `${formatDate(ipo.offer_start_date)} to ${formatDate(ipo.offer_end_date)}`
            : "N/A",
        status: currentStatus,
        category: ipo.category,
        subscription: ipo.subscription || "N/A",
        allotmentDate: ipo.allotment_date,
        listingDate: ipo.listing_date,
      };
    });

    const filteredIpos = ipos.filter((ipo) => {
      if (status === "live") return ipo.status === "LIVE" || ipo.status === "ALLOTMENT PENDING";
      if (status === "upcoming") return ipo.status === "UPCOMING";
      if (status === "closed") return ipo.status === "CLOSED";
      return true;
    });

    res.json(filteredIpos);
  } catch (err) {
    console.error("❌ Error fetching IPOs from DB:", err.message);
    res.status(500).json({ error: "Failed to fetch IPOs" });
  }
}

function formatDate(date) {
  if (!date) return null;
  const d = new Date(date);
  if (isNaN(d)) return null;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

module.exports = { getIposFromDb, syncIpos };
