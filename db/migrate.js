const fs = require('fs');
const path = require('path');
const pool = require('./connection');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const LOCK_KEY = 811237; // arbitrary but shared: serializes concurrent starts

/**
 * Applies schema.sql. Every statement in it is idempotent, so this is safe to
 * run on every boot. The advisory lock keeps concurrent instances (Lambda cold
 * starts, `docker compose up` with replicas) from racing each other's DDL.
 */
async function applySchema() {
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(sql);
    console.log('Schema applied.');
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

module.exports = { applySchema };

if (require.main === module) {
  applySchema()
    .then(() => pool.end())
    .catch((err) => {
      console.error('Failed to apply schema:', err.message);
      process.exit(1);
    });
}
