// routes/IpoRoutes.js
const express = require('express');
const router = express.Router();

// Correctly destructure the function from the controller module
const { getIposFromDb } = require('../controllers/IpoController');

// Ensure you use the function name directly as the handler
router.get('/', getIposFromDb);

module.exports = router;