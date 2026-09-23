'use strict';

const { Router } = require('express');
const googleAuthController = require('../controllers/googleAuthController');
const { requireApiAuth, requireSessionAuth } = require('../middlewares/auth');
const { loginLimiter, registerLimiter } = require('../middlewares/rateLimiter');

const router = Router();

router.get('/url', googleAuthController.getGoogleAuthUrl);
router.get('/link-url', requireSessionAuth, googleAuthController.getGoogleLinkUrl);
router.get('/callback', googleAuthController.googleCallback);
router.post('/callback', googleAuthController.googleCallback);

router.post('/login', loginLimiter, googleAuthController.googleLogin);
router.post('/register', registerLimiter, googleAuthController.googleRegister);

router.get('/userinfo', requireApiAuth, googleAuthController.getGoogleUserInfo);
router.post('/link', requireSessionAuth, googleAuthController.linkGoogleAccount);
router.post('/unlink', requireSessionAuth, googleAuthController.unlinkGoogleAccount);

module.exports = router;
