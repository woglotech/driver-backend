const express = require('express');
const router = express.Router();

const appVersionController = require('../controllers/appVersionController');

router.get('/version-check', appVersionController.checkVersion);

module.exports = router;
