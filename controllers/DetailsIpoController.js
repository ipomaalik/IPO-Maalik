const axios = require('axios');
const cheerio = require('cheerio');
// 👉 REPLACED: No longer need to import the Client directly.
// const { Client } = require('pg'); 

// 👉 ADDED: Import the connection pool. Adjust the path if your db.js file is elsewhere.
const pool = require('../db'); 

/**
 * Strips all HTML tags from a given string.
 * @param {string} htmlString - The HTML string to be cleaned.
 * @returns {string} The plain text string without HTML tags.
 */
function stripHtmlTags(htmlString) {
    if (!htmlString) return null;
    return htmlString.replace(/(<([^>]+)>)/gi, '').trim();
}

/**
 * Formats an IPO name for use in ipopremium.in URLs.
 * @param {string} name - The raw IPO name.
 * @returns {string} The URL-friendly formatted name.
 */
function formatNameForUrl(name) {
    if (!name) return "";
    return name
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "") // Remove all non-alphanumeric or space characters
        .replace(/\s+/g, "-") // Replace spaces with a single hyphen
        .trim();
}


// --- START: NEW MULTI-STRATEGY SCRAPING LOGIC ---

/**
 * SCRAPER STRATEGY 1: Handles the layout with <p> tags following <h2> headers.
 * This matches the newer layout found on some pages.
 * @param {object} $ - The cheerio instance.
 * @param {string} url - The URL being scraped (for logging).
 * @returns {object|null} The analysis object or null if not found.
 */
function scrapeAnalysisFromH2P($, url) {
    const analysis = { strengths: [], weaknesses: [] };

    // Find the "Strength" h2 tag by filtering for its exact text
    const strengthHeader = $('h2').filter((i, el) => $(el).text().trim().toLowerCase() === 'strength').first();
    if (strengthHeader.length) {
        // Get all subsequent <p> tags until the next <h2>
        strengthHeader.nextUntil('h2', 'p').each((i, el) => {
            const text = $(el).text().trim();
            if (text) analysis.strengths.push(text);
        });
    }

    // Find the "Weakness" h2 tag
    const weaknessHeader = $('h2').filter((i, el) => $(el).text().trim().toLowerCase() === 'weakness').first();
    if (weaknessHeader.length) {
        // Get all subsequent <p> tags
        weaknessHeader.nextAll('p').each((i, el) => {
            const text = $(el).text().trim();
            if (text) analysis.weaknesses.push(text);
        });
    }
    
    if (analysis.strengths.length > 0 || analysis.weaknesses.length > 0) {
        return analysis;
    }
    return null;
}

/**
 * SCRAPER STRATEGY 2: Handles the layout with div.card and <ul> lists. (Fallback)
 * @param {object} $ - The cheerio instance.
 * @param {string} url - The URL being scraped (for logging).
 * @returns {object|null} The analysis object or null if not found.
 */
function scrapeAnalysisFromCards($, url) {
    const analysis = { strengths: [], weaknesses: [] };
    const cards = $('div.card');

    cards.each((i, card) => {
        const headerText = $(card).find('.card-header').text().trim().toLowerCase();
        if (headerText.includes('strengths')) {
            $(card).find('.card-body ul li').each((j, item) => {
                const text = $(item).text().trim();
                if (text) analysis.strengths.push(text);
            });
        }
        if (headerText.includes('weaknesses')) {
            $(card).find('.card-body ul li').each((j, item) => {
                const text = $(item).text().trim();
                if (text) analysis.weaknesses.push(text);
            });
        }
    });

    if (analysis.strengths.length > 0 || analysis.weaknesses.length > 0) {
        return analysis;
    }
    return null;
}


/**
 * Main scraper function that tries multiple strategies to get investment analysis.
 * @param {string} url - The URL to scrape.
 * @returns {Promise<object|null>} A JSON object with strengths and weaknesses, or null on failure.
 */
async function scrapeInvestmentAnalysis(url) {
    try {
        const { data: pageHtml } = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' }
        });
        const $ = cheerio.load(pageHtml);

        // Strategy 1: Try the H2 -> P tag layout first.
        let analysis = scrapeAnalysisFromH2P($, url);
        if (analysis) return analysis;

        // Strategy 2: Fallback to the Card -> UL layout.
        analysis = scrapeAnalysisFromCards($, url);
        if (analysis) return analysis;
        
        // If neither strategy worked, log a warning.
        return null;

    } catch (err) {
        console.error(`❌ Failed to fetch or scrape investment analysis from ${url}: ${err.message}`);
        return null;
    }
}
// --- END: NEW MULTI-STRATEGY SCRAPING LOGIC ---


/**
 * Scrapes subscription data from a dedicated Chittorgarh URL.
 * @param {string} url - The URL to scrape.
 * @returns {Promise<object>} A JSON object with subscription data, or null on failure.
 */
async function scrapeSubscriptionData(url) {
    try {
        const response = await axios.get(url);
        const $ = cheerio.load(response.data);
        const subscriptionStatus = {};

        const subscriptionHeading = $('h2:contains("Subscription")');
        const table = subscriptionHeading.length > 0 ? subscriptionHeading.next('table') : null;

        if (table && table.length > 0) {
            table.find('tbody tr').each((i, row) => {
                const category = $(row).find('td').eq(0).text().trim();
                const subscription = $(row).find('td').eq(1).text().trim();

                if (category && subscription && !category.toLowerCase().includes('total')) {
                    subscriptionStatus[category] = subscription;
                }
            });

            if (Object.keys(subscriptionStatus).length > 0) {
                return subscriptionStatus;
            }
        }
        return null;
    } catch (err) {
        console.error(`❌ Failed to scrape subscription data from ${url}: ${err.message}`);
        return null;
    }
}

/**
 * Scrapes IPO details from a dedicated Chittorgarh URL.
 * @param {string} url - The URL to scrape.
 * @returns {Promise<object>} A JSON object with IPO details, or null on failure.
 */
async function scrapeIpoDetails(url) {
    try {
        const response = await axios.get(url);
        const $ = cheerio.load(response.data);
        const ipoDetails = {};

        const detailsHeading = $('h2:contains("Details")');
        const table = detailsHeading.length > 0 ? detailsHeading.nextAll('div.table-responsive').find('table').first() : null;

        if (table && table.length > 0) {
            table.find('tbody tr').each((i, row) => {
                const keyElement = $(row).find('td').eq(0);
                const valueElement = $(row).find('td').eq(1);

                const key = stripHtmlTags(keyElement.html()).replace(/(\r\n|\n|\r)/gm, "").trim();
                const value = stripHtmlTags(valueElement.html()).replace(/(\r\n|\n|\r)/gm, "").trim();

                if (key && value) {
                    ipoDetails[key] = value;
                }
            });

            if (Object.keys(ipoDetails).length > 0) {
                return ipoDetails;
            }
        }
        return null;
    } catch (err) {
        console.error(`❌ Failed to scrape IPO details from ${url}: ${err.message}`);
        return null;
    }
}

/**
 * Scrapes IPO timeline data from a dedicated Chittorgarh URL.
 * @param {string} url - The URL to scrape.
 * @returns {Promise<object>} A JSON object with IPO timeline data, or null on failure.
 */
async function scrapeIpoTimeline(url) {
    try {
        const response = await axios.get(url);
        const $ = cheerio.load(response.data);
        const ipoTimeline = {};

        const timelineTable = $('td:contains("IPO Open Date")').closest('table');

        if (timelineTable.length > 0) {
            timelineTable.find('tbody tr').each((i, row) => {
                const key = $(row).find('td').eq(0).text().trim();
                let value = $(row).find('td').eq(1).text().trim();

                if (['IPO Open Date', 'IPO Close Date', 'Tentative Allotment', 'Tentative Listing Date'].includes(key)) {
                    value = value.split(',').slice(1).join(',').trim();
                    ipoTimeline[key] = value;
                }
            });
            if (Object.keys(ipoTimeline).length > 0) {
                return ipoTimeline;
            }
        }
        return null;
    } catch (err) {
        console.error(`❌ Failed to scrape IPO timeline from ${url}: ${err.message}`);
        return null;
    }
}

/**
 * Scrapes lot size and investment data from a dedicated Chittorgarh URL.
 * @param {string} url - The URL to scrape.
 * @returns {Promise<object>} A JSON object with lot size and investment data, or null on failure.
 */
async function scrapeLotSizeInvestment(url) {
    try {
        const response = await axios.get(url);
        const $ = cheerio.load(response.data);
        const lotSizeInvestment = {
            minimumInvestment: {},
            categoryAllocation: {}
        };

        const investmentTable = $('td:contains("Retail (Min)")').closest('table');
        if (investmentTable.length > 0) {
            const retailMinRow = investmentTable.find('td:contains("Retail (Min)")').closest('tr');
            if (retailMinRow.length > 0) {
                const shares = retailMinRow.find('td').eq(2).text().trim();
                const amount = retailMinRow.find('td').eq(3).text().trim();
                lotSizeInvestment.minimumInvestment['Retail (Min)'] = `${shares} shares - ${amount}`;
            }

            const retailMaxRow = investmentTable.find('td:contains("Retail (Max)")').closest('tr');
            if (retailMaxRow.length > 0) {
                const shares = retailMaxRow.find('td').eq(2).text().trim();
                const amount = retailMaxRow.find('td').eq(3).text().trim();
                lotSizeInvestment.minimumInvestment['Retail (Max)'] = `${shares} shares - ${amount}`;
            }
        }

        let qibPercentage = 0;
        let niiPercentage = 0;
        let retailPercentage = 0;
        let qibShares = 0;
        let niiShares = 0;
        let retailShares = 0;
        let totalShares = 0;

        const allocationTable = $('td:contains("QIB Shares Offered")').closest('table');
        if (allocationTable.length > 0) {
            allocationTable.find('tbody tr').each((i, row) => {
                const key = $(row).find('td').eq(0).text().trim();
                const value = $(row).find('td').eq(1).text().trim();
                const currentShareCount = parseInt(value.replace(/,/g, ''), 10);

                if (!isNaN(currentShareCount)) {
                    if (key.includes('QIB Shares Offered')) {
                        qibShares = currentShareCount;
                    } else if (key.includes('NII (HNI) Shares Offered')) {
                        niiShares = currentShareCount;
                    } else if (key.includes('Retail Shares Offered')) {
                        retailShares = currentShareCount;
                    } else if (key.includes('Total Shares Offered')) {
                        totalShares = currentShareCount;
                    }
                }

                const matchInParens = value.match(/\(([\d.]+)\%\)/);

                if (matchInParens) {
                    const percentage = parseFloat(matchInParens[1]);
                    if (key.includes('QIB Shares Offered')) {
                        qibPercentage += percentage;
                    } else if (key.includes('NII (HNI) Shares Offered')) {
                        niiPercentage += percentage;
                    } else if (key.includes('Retail Shares Offered') || key.includes('Employee') || key.includes('Shareholder')) {
                        retailPercentage += percentage;
                    }
                } else {
                    const matchInText = value.match(/([\d.]+)\s*%/);
                    if (matchInText) {
                        const percentage = parseFloat(matchInText[1]);
                        if (key.includes('QIB Shares Offered')) {
                            qibPercentage += percentage;
                        } else if (key.includes('NII')) {
                            niiPercentage += percentage;
                        } else if (key.includes('Retail Shares Offered') || key.includes('Employee') || key.includes('Shareholder')) {
                            retailPercentage += percentage;
                        }
                    }
                }
            });
        }

        if (totalShares > 0) {
            if (qibPercentage === 0 && qibShares > 0) {
                qibPercentage = (qibShares / totalShares) * 100;
            }
            if (niiPercentage === 0 && niiShares > 0) {
                niiPercentage = (niiShares / totalShares) * 100;
            }
            if (retailPercentage === 0 && retailShares > 0) {
                retailPercentage = (retailShares / totalShares) * 100;
            }
        }

        const allocationsFound = qibPercentage > 0 || niiPercentage > 0 || retailPercentage > 0;

        if (allocationsFound) {
            let roundedQib = Math.round(qibPercentage);
            let roundedNii = Math.round(niiPercentage);
            let roundedRetail = Math.round(retailPercentage);

            const total = roundedQib + roundedNii + roundedRetail;
            if (total !== 100 && total > 95 && total < 105) {
                roundedRetail += (100 - total);
            }

            lotSizeInvestment.categoryAllocation['QIB'] = `${roundedQib}%`;
            lotSizeInvestment.categoryAllocation['NII'] = `${roundedNii}%`;
            lotSizeInvestment.categoryAllocation['Retail'] = `${roundedRetail}%`;
        }

        if (Object.keys(lotSizeInvestment.minimumInvestment).length > 0 || allocationsFound) {
            return lotSizeInvestment;
        }

        return null;
    } catch (err) {
        console.error(`❌ Failed to scrape lot size & investment from ${url}: ${err.message}`);
        return null;
    }
}

/**
 * Scrapes valuation metrics (P/E, P/B) from a dedicated Chittorgarh URL.
 * @param {string} url - The URL to scrape.
 * @returns {Promise<object|null>} A JSON object with valuation data, or null on failure.
 */
async function scrapeValuationMetrics(url) {
    try {
        const response = await axios.get(url);
        const $ = cheerio.load(response.data);
        const valuationMetrics = {};

        const peRow = $('td:contains("P/E (x)")').closest('tr');
        if (peRow.length > 0) {
            const peValue = peRow.find('td').eq(1).text().trim();
            if (peValue) {
                valuationMetrics['P/E Ratio'] = `${peValue}x`;
            }
        }

        const pbRow = $('td:contains("Price to Book Value")').closest('tr');
        if (pbRow.length > 0) {
            const pbValue = pbRow.find('td').eq(1).text().trim();
            if (pbValue) {
                valuationMetrics['P/B Ratio'] = `${pbValue}x`;
            }
        }

        if (Object.keys(valuationMetrics).length > 0) {
            return valuationMetrics;
        }

        return null;
    } catch (err) {
        console.error(`❌ Failed to scrape valuation metrics from ${url}: ${err.message}`);
        return null;
    }
}


/**
 * Scrapes company financials from a dedicated Chittorgarh URL into a row-oriented format.
 * @param {string} url - The URL to scrape.
 * @returns {Promise<object|null>} An object with metrics as keys, or null on failure.
 */
async function scrapeCompanyFinancials(url) {
    try {
        const response = await axios.get(url);
        const $ = cheerio.load(response.data);

        const table = $('#financialTable');
        if (table.length === 0) {
            return null;
        }

        const financials = {};
        const periods = [];

        const headerRow = table.find('tbody tr').first();
        headerRow.find('td').slice(1).each((i, el) => {
            periods.push($(el).text().trim());
        });

        if (periods.length === 0) {
            return null;
        }

        table.find('tbody tr').slice(1).each((i, row) => {
            const cells = $(row).find('td');
            const metricName = cells.first().text().trim();

            if (metricName) {
                financials[metricName] = {};
                cells.slice(1).each((colIndex, cell) => {
                    const period = periods[colIndex];
                    if (period) {
                        financials[metricName][period] = $(cell).text().trim();
                    }
                });
            }
        });

        return Object.keys(financials).length > 0 ? financials : null;

    } catch (err) {
        console.error(`❌ Failed to scrape company financials from ${url}: ${err.message}`);
        return null;
    }
}

/**
 * Scrapes Key Performance Indicators (KPIs) from a dedicated Chittorgarh URL.
 * @param {string} url - The URL to scrape.
 * @returns {Promise<object|null>} A JSON object with KPI data, or null on failure.
 */
async function scrapeKpiMetrics(url) {
    try {
        const response = await axios.get(url);
        const $ = cheerio.load(response.data);
        const kpiMetrics = {
            "KPI intro": {}
        };
        const excludedKeys = ['P/E (x)', 'EPS (Rs)', 'Price to Book Value'];

        const heading = $('h2:contains("Key Performance Indicator")');
        if (heading.length === 0) {
            return null;
        }

        const marketCapText = heading.next('p').text().trim();
        if (marketCapText) {
            kpiMetrics["KPI intro"]['Market Capitalization'] = marketCapText;
        }

        const kpiDateText = heading.next('p').next('p').text().trim();
        if (kpiDateText) {
            kpiMetrics["KPI intro"]['KPI as of'] = kpiDateText;
        }

        const kpiTable = $('#pecalc_section').find('table');
        let tableDataFound = false;
        if (kpiTable.length > 0) {
            kpiTable.find('tbody tr').each((i, row) => {
                const key = $(row).find('td').eq(0).text().trim();
                const value = $(row).find('td').eq(1).text().trim();

                if (key && value && !excludedKeys.includes(key)) {
                    kpiMetrics[key] = value;
                    tableDataFound = true;
                }
            });
        }

        if (Object.keys(kpiMetrics["KPI intro"]).length === 0 && !tableDataFound) {
            return null;
        }

        return kpiMetrics;

    } catch (err) {
        console.error(`❌ Failed to scrape KPI metrics from ${url}: ${err.message}`);
        return null;
    }
}

/**
 * Scrapes the Objects of the Issue section from a dedicated Chittorgarh URL.
 * It can handle both table and list formats.
 * @param {string} url - The URL to scrape.
 * @returns {Promise<object|null>} A JSON object with intro text and a list of objectives, or null.
 */
async function scrapeObjectivesOfTheIssue(url) {
    try {
        const response = await axios.get(url);
        const $ = cheerio.load(response.data);
        const result = {
            intro: '',
            objectives: []
        };

        const container = $('#ipo-objectives-section');
        if (container.length === 0) {
            return null;
        }

        const introText = container.find('p').first().text().trim();
        if (introText) {
            result.intro = introText;
        }

        const objectivesTable = container.find('#ObjectiveIssue');
        if (objectivesTable.length > 0) {
            objectivesTable.find('tbody tr').each((i, row) => {
                const cells = $(row).find('td');
                const objectiveData = {
                    "S.No.": cells.eq(0).text().trim(),
                    "Objects of the Issue": cells.eq(1).text().trim(),
                    "Expected Amount (₹ in crores)": cells.eq(2).text().trim()
                };
                result.objectives.push(objectiveData);
            });
        }
        else {
            const objectivesList = container.find('ul, ol');
            if (objectivesList.length > 0) {
                objectivesList.find('li').each((i, el) => {
                    const text = $(el).text().trim();
                    if (text) {
                        const objectiveData = {
                           "S.No.": (i + 1).toString(),
                           "Objects of the Issue": text,
                           "Expected Amount (₹ in crores)": "-"
                        };
                        result.objectives.push(objectiveData);
                    }
                });
            }
        }

        if (!result.intro && result.objectives.length === 0) {
            return null;
        }

        return result;

    } catch (err) {
        console.error(`❌ Failed to scrape objectives of the issue from ${url}: ${err.message}`);
        return null;
    }
}


/**
 * Scrapes Anchor Investor data from the subscription page.
 * @param {string} url - The subscription URL to scrape.
 * @returns {Promise<Array<object>|null>} An array of objects, each representing an anchor investor, or null.
 */
async function scrapeAnchorInvestors(url) {
    try {
        const response = await axios.get(url);
        const $ = cheerio.load(response.data);
        const investors = [];

        const anchorTable = $('th:contains("Anchor Investor")').closest('table');

        if (anchorTable.length === 0) {
            return null;
        }

        anchorTable.find('tbody tr:not(.collapse)').each((i, row) => {
            const cells = $(row).find('td');
            if (cells.length < 6) return;

            const investorData = {
                'S.No.': cells.eq(0).text().trim(),
                'Anchor Investor': cells.eq(1).text().trim(),
                'No. of Shares Allotted': cells.eq(2).text().trim(),
                'Amount (Rs.cr.)': cells.eq(3).text().trim(),
                '% Allotment within Anchor Investor Portion': cells.eq(4).text().trim(),
                '% Allotment of Issue': cells.eq(5).text().trim(),
            };
            investors.push(investorData);
        });

        return investors.length > 0 ? investors : null;

    } catch (err) {
        console.error(`❌ Failed to scrape anchor investors from ${url}: ${err.message}`);
        return null;
    }
}


/**
 * Performs a deep comparison of two objects.
 * @param {any} a - The first object.
 * @param {any} b - The second object.
 * @returns {boolean} True if the objects are deeply equal, false otherwise.
 */
function isEqual(a, b) {
    if (a === b) return true;
    if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return false;

    const keysA = Object.keys(a);
    const keysB = Object.keys(b);

    if (keysA.length !== keysB.length) return false;

    for (const key of keysA) {
        if (!keysB.includes(key) || !isEqual(a[key], b[key])) {
            return false;
        }
    }

    return true;
}

/**
 * Syncs detailed IPO data for all IPOs in the database.
 * @returns {Promise<void>}
 */
async function DetailsIPO() {
    // 👉 REPLACED: No longer creating a new Client instance.
    // const client = new Client({ ... });

    try {
        // 👉 REMOVED: No need for client.connect() when using a pool.
        // await client.connect();
        console.log('Successfully connected to the database for detailed IPO sync.');

        // 👉 MODIFIED: Using pool.query instead of client.query
        const { rows: ipoDetails } = await pool.query(`
            SELECT 
                d.details_ipo_id, 
                d.url_rewrite,
                i.id as ipopremium_id,
                i.name as ipopremium_name
            FROM details_ipo d
            JOIN ipos i ON d.details_ipo_id = i.details_ipo_id
            WHERE i.id IS NOT NULL AND i.name IS NOT NULL
        `);

        for (const ipo of ipoDetails) {
            const chittorgarhDetailsUrl = `https://www.chittorgarh.com/ipo/${ipo.url_rewrite}/${ipo.details_ipo_id}/`;
            const chittorgarhSubscriptionUrl = `https://www.chittorgarh.com/ipo_subscription/${ipo.url_rewrite}/${ipo.details_ipo_id}/`;
            
            const formattedName = formatNameForUrl(ipo.ipopremium_name);
            const ipoPremiumUrl = `https://www.ipopremium.in/view/ipo/${ipo.ipopremium_id}/${formattedName}`;


            let htmlResponse;
            try {
                htmlResponse = await axios.get(chittorgarhDetailsUrl);
            } catch (fetchErr) {
                console.error(`❌ Failed to fetch main details for ${ipo.url_rewrite}: ${fetchErr.message}`);
                continue;
            }

            const $ = cheerio.load(htmlResponse.data);

            const issueSizeRow = $('td:contains("Total Issue Size")').closest('tr');
            let newIssueSize = 'N/A';
            if (issueSizeRow.length > 0) {
                const newIssueSizeText = issueSizeRow.find('td').eq(1).text().trim();
                const regex = /₹\s*[\d,]+\.?\d*\s*Cr/i;
                const match = newIssueSizeText.match(regex);
                newIssueSize = match ? match[0].trim() : 'N/A';
            }

            const aboutCompanyDiv = $('#ipoSummary');
            const newAboutCompanyRaw = aboutCompanyDiv.length > 0 ? aboutCompanyDiv.html() : null;
            const newAboutCompany = stripHtmlTags(newAboutCompanyRaw);

            // --- Call all scraping functions (including the new one) ---
            const newIpoDetails = await scrapeIpoDetails(chittorgarhDetailsUrl);
            const newIpoTimeline = await scrapeIpoTimeline(chittorgarhDetailsUrl);
            const newLotSizeInvestment = await scrapeLotSizeInvestment(chittorgarhDetailsUrl);
            const newSubscriptionStatus = await scrapeSubscriptionData(chittorgarhSubscriptionUrl);
            const newValuationMetrics = await scrapeValuationMetrics(chittorgarhDetailsUrl);
            const newCompanyFinancials = await scrapeCompanyFinancials(chittorgarhDetailsUrl);
            const newKpiMetrics = await scrapeKpiMetrics(chittorgarhDetailsUrl);
            const newObjectives = await scrapeObjectivesOfTheIssue(chittorgarhDetailsUrl);
            const newAnchorInvestors = await scrapeAnchorInvestors(chittorgarhSubscriptionUrl);
            const newInvestmentAnalysis = await scrapeInvestmentAnalysis(ipoPremiumUrl);


            // --- Get current data from DB (MODIFIED to include investment_analysis) ---
            // 👉 MODIFIED: Using pool.query instead of client.query
            const { rows: currentIpoRows } = await pool.query(
                'SELECT key_metrics, about_company, subscription_status, ipo_details, ipo_timeline, lot_size_investment, valuation_metrics, company_financials, kpi_metrics, objectives_of_the_issue, anchor_investors, investment_analysis FROM details_ipo WHERE details_ipo_id = $1',
                [ipo.details_ipo_id]
            );

            const currentAboutCompany = currentIpoRows[0]?.about_company || null;
            const currentIssueSize = currentIpoRows[0]?.key_metrics?.issue_size || 'N/A';
            const currentSubscriptionStatus = currentIpoRows[0]?.subscription_status || null;
            const currentIpoDetails = currentIpoRows[0]?.ipo_details || null;
            const currentIpoTimeline = currentIpoRows[0]?.ipo_timeline || null;
            const currentLotSizeInvestment = currentIpoRows[0]?.lot_size_investment || null;
            const currentValuationMetrics = currentIpoRows[0]?.valuation_metrics || null;
            const currentCompanyFinancials = currentIpoRows[0]?.company_financials || null;
            const currentKpiMetrics = currentIpoRows[0]?.kpi_metrics || null;
            const currentObjectives = currentIpoRows[0]?.objectives_of_the_issue || null;
            const currentAnchorInvestors = currentIpoRows[0]?.anchor_investors || null;
            const currentInvestmentAnalysis = currentIpoRows[0]?.investment_analysis || null;


            // --- Compare all data points for changes (MODIFIED to include investment_analysis) ---
            const issueSizeChanged = newIssueSize !== currentIssueSize;
            const aboutCompanyChanged = newAboutCompany !== currentAboutCompany;
            const subscriptionStatusChanged = !isEqual(newSubscriptionStatus, currentSubscriptionStatus);
            const ipoDetailsChanged = !isEqual(newIpoDetails, currentIpoDetails);
            const ipoTimelineChanged = !isEqual(newIpoTimeline, currentIpoTimeline);
            const lotSizeInvestmentChanged = !isEqual(newLotSizeInvestment, currentLotSizeInvestment);
            const valuationMetricsChanged = !isEqual(newValuationMetrics, currentValuationMetrics);
            const companyFinancialsChanged = !isEqual(newCompanyFinancials, currentCompanyFinancials);
            const kpiMetricsChanged = !isEqual(newKpiMetrics, currentKpiMetrics);
            const objectivesChanged = !isEqual(newObjectives, currentObjectives);
            const anchorInvestorsChanged = !isEqual(newAnchorInvestors, currentAnchorInvestors);
            const investmentAnalysisChanged = !isEqual(newInvestmentAnalysis, currentInvestmentAnalysis);


            if (
                issueSizeChanged ||
                aboutCompanyChanged ||
                subscriptionStatusChanged ||
                ipoDetailsChanged ||
                ipoTimelineChanged ||
                lotSizeInvestmentChanged ||
                valuationMetricsChanged ||
                companyFinancialsChanged ||
                kpiMetricsChanged ||
                objectivesChanged ||
                anchorInvestorsChanged ||
                investmentAnalysisChanged
            ) {
                const keyMetricsJson = { "issue_size": newIssueSize };

                // 👉 MODIFIED: Using pool.query instead of client.query
                await pool.query(
                    `UPDATE details_ipo 
                     SET key_metrics = $1, about_company = $2, subscription_status = $3, 
                         ipo_details = $4, ipo_timeline = $5, lot_size_investment = $6, 
                         valuation_metrics = $7, company_financials = $8, kpi_metrics = $9, 
                         objectives_of_the_issue = $10, anchor_investors = $11, investment_analysis = $12
                     WHERE details_ipo_id = $13`,
                    [
                        JSON.stringify(keyMetricsJson),
                        newAboutCompany,
                        newSubscriptionStatus ? JSON.stringify(newSubscriptionStatus) : null,
                        newIpoDetails ? JSON.stringify(newIpoDetails) : null,
                        newIpoTimeline ? JSON.stringify(newIpoTimeline) : null,
                        newLotSizeInvestment ? JSON.stringify(newLotSizeInvestment) : null,
                        newValuationMetrics ? JSON.stringify(newValuationMetrics) : null,
                        newCompanyFinancials ? JSON.stringify(newCompanyFinancials) : null,
                        newKpiMetrics ? JSON.stringify(newKpiMetrics) : null,
                        newObjectives ? JSON.stringify(newObjectives) : null,
                        newAnchorInvestors ? JSON.stringify(newAnchorInvestors) : null,
                        newInvestmentAnalysis ? JSON.stringify(newInvestmentAnalysis) : null,
                        ipo.details_ipo_id
                    ]
                );
                console.log(`✅ Updated detailed data for ${ipo.url_rewrite}`);
            }
        }
        console.log('✨ Detailed IPO synchronization complete.');
    } catch (err) {
        console.error('An error occurred during detailed IPO synchronization:', err);
    } 
    // 👉 REMOVED: The finally block with client.end() is no longer needed.
    // The pool manages its own connections.
}


/**
 * Express route handler to get IPO details by ID.
 * @param {object} req - The Express request object.
 * @param {object} res - The Express response object.
 */
async function getIpoDetails(req, res) {
    const { details_ipo_id } = req.params;
    // 👉 REPLACED: No longer creating a new Client instance.
    // const client = new Client({ ... });

    try {
        // 👉 REMOVED: No need for client.connect()
        const query = 'SELECT * FROM details_ipo WHERE details_ipo_id = $1';
        // 👉 MODIFIED: Using pool.query
        const { rows } = await pool.query(query, [details_ipo_id]);

        if (rows.length > 0) {
            res.status(200).json(rows[0]);
        } else {
            res.status(404).json({ message: 'IPO details not found.' });
        }
    } catch (err) {
        console.error('Error fetching IPO details:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
    // 👉 REMOVED: The finally block with client.end() is no longer needed.
}

// Export the functions
module.exports = { DetailsIPO, getIpoDetails };