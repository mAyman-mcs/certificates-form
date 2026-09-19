const express = require('express');
const { login, setPassword, getById } = require('./authService');
const { requireAuth } = require('./authMiddleware');

const router = express.Router();

router.get('/me', requireAuth, async (req, res) => {
  const user = await getById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({ user });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required.' });
  }

  try {
    const result = await login(email.trim().toLowerCase(), password);
    if (!result) return res.status(401).json({ error: 'Invalid email or password.' });
    res.json(result);
  } catch (err) {
    console.error('Login failed:', err.message);
    res.status(500).json({ error: 'Login failed.' });
  }
});

// Used both for the forced first-login reset (mustResetPassword: true) and
// for a normal password change later — same flow, verify-then-replace.
router.post('/set-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword and newPassword are required.' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'newPassword must be at least 8 characters.' });
  }

  try {
    const result = await setPassword(req.user.sub, currentPassword, newPassword);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
