# Employee Certifications

Lists every employee with all their certifications, and lets a manager filter by
certificate, vendor, employee name, or expiration status. Data is parsed from an
Excel file (`data/certifications.xlsx`) matching the layout of the source sheet:
one block of `Vendor name / Certificate name / Expiration date` columns per
employee, with the employee's name as a header above their block.

## Run locally

```bash
npm install
npm start
```

Then open http://localhost:3000

## Updating the data

Two sources are merged at read time:

1. **The Excel file** (`data/certifications.xlsx`) — the original bulk import.
   To refresh it: overwrite the file with a new export (same column layout)
   and restart the server.
2. **Manually added entries** — a manager can add one employee/vendor/
   certificate/expiration-date at a time from the "+ Add certification"
   button in the UI. These are stored separately in
   `data/manual-entries.json` (created on first use) so they survive an Excel
   refresh, and are combined with the sheet data on every request. You can
   also add one programmatically:

   ```bash
   curl -X POST http://localhost:3000/api/records \
     -H "Content-Type: application/json" \
     -d '{"employee":"Jane Doe","vendor":"Microsoft","certificate":"AZ-500","expirationDate":"2026-10-01"}'
   ```

## Expiration handling

The source sheet has inconsistent expiration formats (real dates, "N/A",
"expired", "no exp", "FEB, 2027", "25-12-2025", blanks). These, along with
manually-added dates, are normalized into one of:

- `valid` — expiration date more than 90 days away
- `expiring_soon` — expires within 90 days
- `expired` — expiration date has passed, or the cell literally said "expired"
- `no_expiration` — cell said "N/A" / "no exp" / "not exp" (cert doesn't expire)
- `unknown` — cell was blank (no data given)

Status is computed fresh on every request by comparing the stored expiration
date against the current date — it updates automatically day to day without
needing a restart or re-parse.

Logic lives in `lib/parseWorkbook.js` — adjust `NO_EXPIRATION_TEXT`,
`EXPIRED_TEXT`, or the date-format matchers there if new formats show up.

## Deploying

### Docker

```bash
docker build -t employee-certifications .
docker run -p 3000:3000 -v $(pwd)/data:/app/data employee-certifications
```

Mounting `data/` as a volume keeps manually-added entries across container
restarts/redeploys.

### Plain Node (any VM)

```bash
npm install --omit=dev
PORT=3000 node server.js
```

Put this behind a reverse proxy (nginx/Caddy) with HTTPS and, since this is
internal HR-adjacent data, some form of access control (VPN-only, basic auth at
the proxy, or an internal-only network) — the app itself has no login, so
anyone who can reach it can add certification entries.

### AWS Lambda + S3

The app can run on Lambda instead of a server. Set `S3_BUCKET` and it
switches both data files from local disk to S3 automatically — everything
else (routes, UI, expiration logic) is unchanged.

1. **Create a private S3 bucket** and upload the two data files to it:
   ```bash
   aws s3 cp data/certifications.xlsx s3://YOUR_BUCKET/certifications.xlsx
   aws s3 cp data/manual-entries.json s3://YOUR_BUCKET/manual-entries.json
   ```
   To refresh the bulk data later, just re-upload `certifications.xlsx` — no
   redeploy needed, it's read fresh on the next request.

2. **Give the Lambda's execution role** `s3:GetObject` and `s3:PutObject` on
   that bucket (scope to the two keys, not the whole account's S3 access).

3. **Package and deploy** (zip-based, `nodejs20.x` runtime):
   ```bash
   npm ci --omit=dev
   zip -r function.zip server.js lib public node_modules package.json

   aws lambda create-function \
     --function-name employee-certifications \
     --runtime nodejs20.x \
     --handler server.handler \
     --role arn:aws:iam::ACCOUNT_ID:role/YOUR_LAMBDA_ROLE \
     --zip-file fileb://function.zip \
     --timeout 15 \
     --memory-size 512 \
     --environment "Variables={S3_BUCKET=YOUR_BUCKET}"
   ```
   Or as a container image using `Dockerfile.lambda` (AWS's official Lambda
   Node base image — no changes needed to the app for this path either):
   ```bash
   docker build -f Dockerfile.lambda -t employee-certifications-lambda .
   ```

4. **Expose it over HTTP** — the simplest option is a Lambda Function URL:
   ```bash
   aws lambda create-function-url-config \
     --function-name employee-certifications \
     --auth-type AWS_IAM
   ```
   Use `AWS_IAM` (not `NONE`) unless you put another access control layer in
   front — see the access-control note above, it still applies on Lambda.

Manual entries are re-read from S3 on every request rather than cached in
memory, since separate Lambda instances don't share memory and one instance's
write needs to be visible to requests that land on another.

### Environment variables

| Variable       | Default                  | Purpose                                          |
|----------------|---------------------------|---------------------------------------------------|
| `PORT`         | `3000`                    | HTTP port (local/plain Node only)                 |
| `S3_BUCKET`    | _(unset)_                 | When set, switches data storage from disk to S3   |
| `S3_XLSX_KEY`  | `certifications.xlsx`     | S3 key for the bulk workbook                      |
| `S3_MANUAL_KEY`| `manual-entries.json`     | S3 key for manually-added entries                 |

## Project structure

```
server.js                 Express app: serves the UI + /api/data + /api/records
                           (also exports a Lambda `handler` via serverless-http)
lib/parseWorkbook.js       Excel parsing + expiration normalization
lib/s3Store.js             S3 read/write, used instead of fs when S3_BUCKET is set
data/certifications.xlsx   Bulk source data (from Excel)
data/manual-entries.json   Entries added via the "+ Add certification" form
public/                    Frontend (static, no build step)
Dockerfile.lambda          Lambda container-image build (alternative to zip deploy)
```
