const express = require("express");
const { getIpoDetails } = require("../controllers/DetailsIpoController"); // Corrected function name

const router = express.Router();

// GET /api/details-ipo/:details_ipo_id/:url_rewrite
router.get("/:details_ipo_id/:url_rewrite", getIpoDetails);

module.exports = router;
