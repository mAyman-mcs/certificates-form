const pool = require('./connection');

/**
 * Resolves a free-typed vendor name to a vendor id, creating the row if it's
 * new. Takes a client rather than the pool so it joins the caller's
 * transaction — otherwise a failed certificate insert would leave the vendor
 * behind. uq_vendors_lower_name is what makes "Fortinet" resolve to an
 * existing "fortinet" instead of creating a twin.
 */
async function ensureVendor(client, name) {
  const clean = String(name || '').trim().replace(/\s+/g, ' ');
  if (!clean) throw new Error('Vendor name is required.');

  // Bare ON CONFLICT (no target): the table carries two unique indexes.
  await client.query('INSERT INTO vendors (name) VALUES ($1) ON CONFLICT DO NOTHING', [clean]);
  const { rows } = await client.query('SELECT id FROM vendors WHERE lower(name) = lower($1)', [clean]);
  return rows[0].id;
}

async function listVendors() {
  const { rows } = await pool.query('SELECT id, name FROM vendors ORDER BY name');
  return rows;
}

module.exports = { ensureVendor, listVendors };
