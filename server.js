const path = require('path');
const fs = require('fs');
const express = require('express');
const serverless = require('serverless-http');
const { parseWorkbook, parseWorkbookBuffer, parseExpirationRaw, computeStatus } = require('./lib/parseWorkbook');
const { normalizeRecords } = require('./lib/normalizeNames');
const s3Store = require('./lib/s3Store');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'certifications.xlsx');
const MANUAL_FILE = path.join(__dirname, 'data', 'manual-entries.json');
const S3_XLSX_KEY = process.env.S3_XLSX_KEY || 'certifications.xlsx';
const S3_MANUAL_KEY = process.env.S3_MANUAL_KEY || 'manual-entries.json';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let sheetRecords = [];
let sheetError = null;
let loadedAt = null;
let manualRecords = [];

async function loadSheet() {
  try {
    if (s3Store.isEnabled) {
      const buffer = await s3Store.getObject(S3_XLSX_KEY);
      if (!buffer) throw new Error(`No workbook found at s3://${process.env.S3_BUCKET}/${S3_XLSX_KEY}`);
      sheetRecords = parseWorkbookBuffer(buffer);
    } else {
      sheetRecords = parseWorkbook(DATA_FILE);
    }
    sheetError = null;
    loadedAt = new Date().toISOString();
    console.log(`Loaded ${sheetRecords.length} certification records from workbook at ${loadedAt}`);
  } catch (err) {
    sheetError = err.message;
    console.error('Failed to parse workbook:', err.message);
  }
}

async function loadManualEntries() {
  if (s3Store.isEnabled) {
    try {
      const buffer = await s3Store.getObject(S3_MANUAL_KEY);
      manualRecords = buffer ? JSON.parse(buffer.toString('utf8')) : [];
    } catch (err) {
      console.error('Failed to read manual entries from S3, starting empty:', err.message);
      manualRecords = [];
    }
    return;
  }

  if (!fs.existsSync(MANUAL_FILE)) {
    manualRecords = [];
    return;
  }
  try {
    manualRecords = JSON.parse(fs.readFileSync(MANUAL_FILE, 'utf8'));
  } catch (err) {
    console.error('Failed to read manual entries file, starting empty:', err.message);
    manualRecords = [];
  }
}

async function saveManualEntries() {
  if (s3Store.isEnabled) {
    await s3Store.putObject(S3_MANUAL_KEY, JSON.stringify(manualRecords, null, 2), 'application/json');
    return;
  }

  fs.mkdirSync(path.dirname(MANUAL_FILE), { recursive: true });
  fs.writeFileSync(MANUAL_FILE, JSON.stringify(manualRecords, null, 2));
}

function withStatus(record, now) {
  const date = record.expirationDate ? new Date(record.expirationDate) : null;
  return { ...record, status: computeStatus(record.kind, date, now) };
}

function allRecordsWithStatus() {
  const now = new Date();
  const normalized = normalizeRecords([...sheetRecords, ...manualRecords]);
  return normalized.map((r) => withStatus(r, now));
}

app.get('/api/data', async (req, res) => {
  // Reload from S3 on every request: separate Lambda instances don't share
  // memory, so a cached copy could miss entries another instance just wrote.
  if (s3Store.isEnabled) {
    await loadManualEntries();
  }
  res.json({
    loadedAt,
    error: sheetError,
    records: allRecordsWithStatus(),
  });
});

app.post('/api/records', async (req, res) => {
  const { employee, vendor, certificate, expirationDate } = req.body || {};

  if (!employee || !employee.trim() || !vendor || !vendor.trim() ||
      !certificate || !certificate.trim()) {
    return res.status(400).json({ error: 'employee, vendor, and certificate are required.' });
  }

  // Expiration date is optional: some certifications never expire. If none
  // is given, treat it the same as the sheet's "N/A" / "no exp" entries.
  const trimmedExpiration = (expirationDate || '').trim();
  let date = null;
  let text = '';
  let kind = 'no_expiration';

  if (trimmedExpiration) {
    const parsed = parseExpirationRaw(trimmedExpiration);
    if (!parsed.date) {
      return res.status(400).json({ error: 'Could not understand the expiration date.' });
    }
    date = parsed.date;
    text = parsed.text;
    kind = parsed.kind;
  }

  const record = {
    id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    employee: employee.trim(),
    vendor: vendor.trim(),
    certificate: certificate.trim(),
    expirationDate: date ? date.toISOString().slice(0, 10) : null,
    expirationText: text,
    kind,
    source: 'manual',
  };

  if (s3Store.isEnabled) {
    await loadManualEntries(); // pick up entries another instance may have written
  }
  manualRecords.push(record);
  await saveManualEntries();

  res.status(201).json({ ok: true, record: withStatus(record, new Date()) });
});

const ready = (async () => {
  await loadManualEntries();
  if (s3Store.isEnabled || fs.existsSync(DATA_FILE)) {
    await loadSheet();
  } else {
    console.warn(`No data file found at ${DATA_FILE}.`);
  }
})();

if (require.main === module) {
  ready.then(() => {
    app.listen(PORT, () => {
      console.log(`Employee certifications app listening on http://localhost:${PORT}`);
    });
  });
}

// Lambda entry point (handler: server.handler). Waits for the initial data
// load before handing the request to serverless-http on cold start.
const httpHandler = serverless(app);
module.exports.handler = async (event, context) => {
  await ready;
  return httpHandler(event, context);
};
