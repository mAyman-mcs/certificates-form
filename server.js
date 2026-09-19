const path = require('path');
const express = require('express');
const serverless = require('serverless-http');
const pool = require('./db/connection');
const { applySchema } = require('./db/migrate');
const usersRepo = require('./db/usersRepo');
const authRoutes = require('./data/auth/authRoutes');
const adminRouter = require('./data/admin/adminRouter');
const { router: certificatesRouter } = require('./data/certificates/certificatesRouter');
const { requireAuth } = require('./data/auth/authMiddleware');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Public, and registered before anything auth-related — the compose healthcheck
// uses it to decide the app (and therefore the schema) is ready.
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ ok: false, error: 'Database unavailable.' });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRouter);
app.use('/api/certificates', requireAuth, certificatesRouter);

// Only an admin or the user themselves may view a given profile photo.
app.get('/api/users/:id/photo', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).end();
  if (req.user.role !== 'admin' && req.user.sub !== id) return res.status(403).end();

  try {
    const photo = await usersRepo.getPhoto(id);
    if (!photo) return res.status(404).end();
    res.set('Content-Type', photo.mimeType);
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(photo.data);
  } catch (err) {
    console.error('Failed to load photo:', err.message);
    res.status(500).end();
  }
});

const ready = (async () => {
  if (process.env.SCHEMA_AUTO_APPLY !== 'false') {
    await applySchema();
  }
})();

if (require.main === module) {
  ready
    .then(() => {
      app.listen(PORT, () => {
        console.log(`Employee certifications app listening on http://localhost:${PORT}`);
      });
    })
    .catch((err) => {
      console.error('Startup failed:', err.message);
      process.exit(1);
    });
}

// Lambda entry point (handler: server.handler). Awaiting `ready` guarantees the
// schema exists before the first request on a cold start.
const httpHandler = serverless(app);
module.exports.handler = async (event, context) => {
  await ready;
  return httpHandler(event, context);
};
