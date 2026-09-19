-- Employee certifications schema: vendors, users (employees), and the
-- certificates that link them. A user's "certified vendors" isn't stored as
-- its own column — it's derived from certificates (one user can hold many
-- certs across many vendors) via the user_certified_vendors view below.

CREATE TABLE IF NOT EXISTS vendors (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  website VARCHAR(255)
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  full_name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE, -- login identifier
  department VARCHAR(255),
  profile_photo_url TEXT, -- S3 key/URL to the photo, not the image bytes
  role VARCHAR(20) NOT NULL DEFAULT 'employee' CHECK (role IN ('admin', 'employee')),
  password_hash TEXT NOT NULL,
  must_reset_password BOOLEAN NOT NULL DEFAULT true, -- true until the user changes their admin-issued temp password
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS certificates (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  certificate_name VARCHAR(255) NOT NULL,
  expiration_date DATE,
  expiration_text VARCHAR(255),
  kind VARCHAR(20) NOT NULL DEFAULT 'unknown'
    CHECK (kind IN ('date', 'no_expiration', 'expired_flag', 'blank', 'unknown')),
  source VARCHAR(10) NOT NULL DEFAULT 'manual' CHECK (source IN ('sheet', 'manual')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, vendor_id, certificate_name)
);

CREATE INDEX IF NOT EXISTS idx_certificates_user_id ON certificates(user_id);
CREATE INDEX IF NOT EXISTS idx_certificates_vendor_id ON certificates(vendor_id);

-- Approval workflow. Written as ALTERs so re-running this file converges an
-- existing database too — CREATE TABLE IF NOT EXISTS alone never adds columns.
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS approval_status VARCHAR(10) NOT NULL DEFAULT 'approved';
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE certificates DROP CONSTRAINT IF EXISTS certificates_approval_status_check;
ALTER TABLE certificates ADD CONSTRAINT certificates_approval_status_check
  CHECK (approval_status IN ('pending', 'approved', 'rejected'));

-- A rejection must carry a reason, and nothing else may.
ALTER TABLE certificates DROP CONSTRAINT IF EXISTS certificates_rejection_reason_check;
ALTER TABLE certificates ADD CONSTRAINT certificates_rejection_reason_check
  CHECK ((approval_status = 'rejected') = (rejection_reason IS NOT NULL AND btrim(rejection_reason) <> ''));

-- The original UNIQUE(user_id, vendor_id, certificate_name) would permanently
-- block re-requesting a certificate after a rejection. This partial index
-- allows at most one *live* (pending or approved) row per person+vendor+cert
-- while letting rejected rows pile up as history. lower() also collapses
-- case-variant duplicates the old constraint let through.
ALTER TABLE certificates DROP CONSTRAINT IF EXISTS certificates_user_id_vendor_id_certificate_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_certificates_active
  ON certificates (user_id, vendor_id, lower(certificate_name))
  WHERE approval_status <> 'rejected';

CREATE INDEX IF NOT EXISTS idx_certificates_pending
  ON certificates (created_at) WHERE approval_status = 'pending';

-- Stops "Fortinet" and "fortinet" becoming two vendors as people free-type them.
CREATE UNIQUE INDEX IF NOT EXISTS uq_vendors_lower_name ON vendors (lower(name));

-- Which vendors each user is certified in, derived from their certificates.
-- A pending request must not make someone "certified".
DROP VIEW IF EXISTS user_certified_vendors;
CREATE VIEW user_certified_vendors AS
SELECT DISTINCT u.id AS user_id, u.full_name, v.id AS vendor_id, v.name AS vendor_name
FROM users u
JOIN certificates c ON c.user_id = u.id AND c.approval_status = 'approved'
JOIN vendors v ON v.id = c.vendor_id;

-- Profile photo, stored as bytes in the row rather than a URL — kept small
-- (2MB cap, enforced by the upload handler, not here) so this stays cheap.
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_photo BYTEA;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_photo_type VARCHAR(100);
