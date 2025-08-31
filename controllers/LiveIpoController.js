// const axios = require("axios");
// const cheerio = require("cheerio");

// const client = axios.create({
//   baseURL: "https://www.ipopremium.in",
//   headers: {
//     "User-Agent":
//       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
//     Accept: "application/json, text/plain, */*",
//   },
//   timeout: 15000,
// });

// const stripHtml = (s = "") => s.replace(/<[^>]*>/g, "").trim();
// const toSlug = (s = "") =>
//   stripHtml(s)
//     .toLowerCase()
//     .replace(/&/g, " and ")
//     .replace(/[^a-z0-9]+/g, "-")
//     .replace(/^-+|-+$/g, "");

// function formatDateString(dateStr) {
//   if (!dateStr) return "";
//   const date = new Date(dateStr);
//   if (isNaN(date)) return dateStr; // fallback to original if parse fails

//   // Adjusting for Indian Standard Time (UTC+5:30) to prevent date shifts.
//   date.setHours(date.getHours() + 5);
//   date.setMinutes(date.getMinutes() + 30);

//   return date.toISOString().split("T")[0]; // YYYY-MM-DD
// }

// async function mapWithConcurrency(items, limit, mapper) {
//   const out = [];
//   for (let i = 0; i < items.length; i += limit) {
//     const chunk = items.slice(i, i + limit);
//     const mapped = await Promise.all(chunk.map(mapper));
//     out.push(...mapped);
//   }
//   return out;
// }

// async function getSubscriptionTimes(ipoId, slug) {
//   try {
//     const { data: html } = await client.get(`/view/ipo/${ipoId}/${slug}`);
//     const $ = cheerio.load(html);

//     let totalTimes = null;

//     // 1️⃣ Look for "Subscription" table
//     $("table:contains('Subscription') tr").each((_, el) => {
//       const firstCell = $(el).find("td").eq(0).text().trim().toLowerCase();
//       if (firstCell.includes("total")) {
//         const cells = $(el).find("td");
//         totalTimes = $(cells[cells.length - 1]).text().trim();
//       }
//     });

//     // 2️⃣ If not found, try finding "Total Subscription" anywhere in the page
//     if (!totalTimes) {
//       $("tr").each((_, el) => {
//         const rowText = $(el).text().toLowerCase();
//         if (rowText.includes("total subscription")) {
//           const numbers = $(el)
//             .text()
//             .match(/(\d+(\.\d+)?)/g);
//           if (numbers && numbers.length) {
//             totalTimes = numbers[numbers.length - 1]; // pick last number in row
//           }
//         }
//       });
//     }

//     // 3️⃣ If still not found, search whole page for a float number in context
//     if (!totalTimes) {
//       const textMatches = html.match(/(\d+(\.\d+)?)(\s*times?)/i);
//       if (textMatches) {
//         totalTimes = textMatches[1];
//       }
//     }

//     return totalTimes || "N/A";
//   } catch (err) {
//     console.error(`Subscription fetch failed for IPO ${ipoId}:`, err.message);
//     return "N/A";
//   }
// }

// async function fetchIposByType(type, category) {
//   const flags = {
//     upcoming_ipos: false,
//     open_ipos: false,
//     closed_ipos: false,
//     eq: false,
//     sme: false,
//     all_ipos: false,
//   };

//   if (type === "open") flags.open_ipos = true;
//   if (type === "upcoming") flags.upcoming_ipos = true;
//   if (category === "mainboard") flags.eq = true;
//   if (category === "sme") flags.sme = true;

//   const { data } = await client.get("/ipo", { params: flags });

//   let rows = [];
//   if (Array.isArray(data)) rows = data;
//   else if (data && Array.isArray(data.data)) rows = data.data;
//   else if (data?.data?.data) rows = data.data.data;

//   return (rows || []).map((row) => ({ ...row, _status: type, _category: category }));
// }

// async function getLiveIpos(req, res) {
//   try {
//     const { status, category, devFallback } = req.query;

//     const tryOrder = status ? [status] : ["open", "upcoming", "closed"];
//     let fetched = [];

//     if (!category || category === "both") {
//       for (const t of tryOrder) {
//         const mainboard = await fetchIposByType(t, "mainboard");
//         const sme = await fetchIposByType(t, "sme");
//         const combined = [...mainboard, ...sme];
//         if (combined.length) {
//           fetched = combined;
//           if (!status) break;
//         }
//       }
//     } else {
//       for (const t of tryOrder) {
//         const rows = await fetchIposByType(t, category);
//         if (rows.length) {
//           fetched = rows;
//           if (!status) break;
//         }
//       }
//     }

//     if (!fetched.length && String(devFallback) === "1") {
//       return res.json([
//         {
//           id: 99901,
//           name: "PQR Fintech",
//           imageUrl: "",
//           priceBand: "₹70-₹75",
//           gmp: "+₹150",
//           subscription: "4.1",
//           openDate: "2025-08-19",
//           closeDate: "2025-08-21",
//           offerDateRange: "2025-08-19 to 2025-08-21",
//           status: "OPEN",
//           category: "mainboard",
//         },
//         {
//           id: 99902,
//           name: "ABC Tech",
//           imageUrl: "",
//           priceBand: "₹120-₹130",
//           gmp: "+₹85",
//           subscription: "2.6",
//           openDate: "2025-08-20",
//           closeDate: "2025-08-22",
//           offerDateRange: "2025-08-20 to 2025-08-22",
//           status: "OPEN",
//           category: "sme",
//         },
//       ]);
//     }

//     const list = await mapWithConcurrency(fetched, 5, async (ipo) => {
//       const id = ipo.id;
//       const nameClean = stripHtml(ipo.name || "");
//       const slug = ipo.slug || toSlug(nameClean);

//       const subscriptionTimes = await getSubscriptionTimes(id, slug);

//       const openDate = formatDateString(ipo.open);
//       const closeDate = formatDateString(ipo.close);

//       return {
//         id,
//         name: nameClean,
//         imageUrl: ipo.icon_url || ipo.icon || "",
//         priceBand: ipo.price || "",
//         gmp: ipo.premium || "",
//         subscription: subscriptionTimes,
//         openDate,
//         closeDate,
//         offerDateRange: `${openDate} to ${closeDate}`,
//         status: (ipo._status || "").toUpperCase(),
//         category: ipo._category || "mainboard",
//       };
//     });

//     res.json(list);
//   } catch (err) {
//     console.error("Error fetching live IPO data:", err.message);
//     res.status(500).json({ error: "Failed to fetch IPOs" });
//   }
// }

// module.exports = { getLiveIpos };
