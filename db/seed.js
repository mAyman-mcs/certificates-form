const bcrypt = require('bcryptjs');
const pool = require('./connection');
const { users: seedUsers, certificates: seedCertificates } = require('./seedData');

const LOCK_KEY = 811238; // distinct from the migrate lock
const SALT_ROUNDS = 10;

const DEFAULT_PASSWORD = process.env.SEED_DEFAULT_PASSWORD || 'P@ssw0rd';
const ADMIN_EMAIL = (process.env.SEED_ADMIN_EMAIL || 'admin@mcsholding.com').toLowerCase();
const ADMIN_NAME = process.env.SEED_ADMIN_NAME || 'System Administrator';

/**
 * Inserts a user if the email is free, and returns its id either way.
 * Never updates password_hash — a re-run must not clobber a password
 * somebody has already chosen for themselves.
 */
async function upsertUser(client, { fullName, email, department, role }, passwordHash) {
  const inserted = await client.query(
    `INSERT INTO users (full_name, email, department, role, password_hash, must_reset_password)
     VALUES ($1, $2, $3, $4, $5, true)
     ON CONFLICT (email) DO NOTHING
     RETURNING id`,
    [fullName, email, department || null, role, passwordHash]
  );
  if (inserted.rows[0]) return { id: inserted.rows[0].id, created: true };

  const existing = await client.query('SELECT id FROM users WHERE email = $1', [email]);
  return { id: existing.rows[0].id, created: false };
}

async function seed() {
  const client = await pool.connect();
  let locked = false;

  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    locked = true;
    await client.query('BEGIN');

    // One hash for every account: bcrypt at cost 10 is ~100ms, and hashing the
    // same plaintext 15 times would add a second of startup for nothing.
    const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, SALT_ROUNDS);

    const admin = await upsertUser(
      client,
      { fullName: ADMIN_NAME, email: ADMIN_EMAIL, department: 'IT', role: 'admin' },
      passwordHash
    );

    const userIds = new Map(); // fullName -> id
    let usersCreated = 0;
    for (const user of seedUsers) {
      const { id, created } = await upsertUser(client, user, passwordHash);
      userIds.set(user.fullName, id);
      if (created) usersCreated += 1;
    }

    const vendorIds = new Map(); // lower(name) -> id
    for (const name of new Set(seedCertificates.map((c) => c.vendor))) {
      // Bare ON CONFLICT: the table carries two unique indexes.
      await client.query('INSERT INTO vendors (name) VALUES ($1) ON CONFLICT DO NOTHING', [name]);
      const { rows } = await client.query('SELECT id FROM vendors WHERE lower(name) = lower($1)', [name]);
      vendorIds.set(name.toLowerCase(), rows[0].id);
    }

    let inserted = 0;
    let skipped = 0;
    for (const cert of seedCertificates) {
      const userId = userIds.get(cert.employee);
      if (!userId) {
        // Loud failure, never a silent skip: a certificate with no owner means
        // seedData.js is internally inconsistent and needs fixing.
        throw new Error(`Certificate references unknown employee "${cert.employee}" (${cert.certificate}).`);
      }

      const { rows } = await client.query(
        `INSERT INTO certificates
           (user_id, vendor_id, certificate_name, expiration_date, expiration_text,
            kind, source, approval_status, requested_by, reviewed_by, reviewed_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'sheet', 'approved', $1, $7, now())
         ON CONFLICT (user_id, vendor_id, lower(certificate_name))
           WHERE approval_status <> 'rejected'
         DO NOTHING
         RETURNING id`,
        [
          userId,
          vendorIds.get(cert.vendor.toLowerCase()),
          cert.certificate,
          cert.expirationDate,
          cert.expirationText,
          cert.kind,
          admin.id,
        ]
      );
      if (rows[0]) inserted += 1;
      else skipped += 1;
    }

    await client.query('COMMIT');

    console.log(`Seed complete: ${inserted} certificates inserted, ${skipped} already present.`);
    console.log(`Users: ${usersCreated} created, ${seedUsers.length - usersCreated} already present.`);
    console.log(`Admin account: ${ADMIN_EMAIL}`);
    console.log(
      'Every seeded account starts with the shared default password and must ' +
      'change it on first login. Override it with SEED_DEFAULT_PASSWORD.'
    );
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

module.exports = { seed };

if (require.main === module) {
  seed()
    .then(() => pool.end())
    .catch((err) => {
      console.error('Seed failed:', err.message);
      process.exit(1);
    });
}
