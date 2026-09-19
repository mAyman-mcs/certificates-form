# Employee Certifications

Tracks every employee's IT certifications, with a request/approval workflow:
employees submit certificates for review, admins approve or reject them. Data
lives in Postgres.

Two roles:

- **Admin** — sees everyone's certificates; can create/update/delete users,
  add a certificate directly for any user, and approve, reject, or delete
  certificate requests.
- **Employee** — sees only their own certificates (including pending and
  rejected ones), can submit new certificate requests, and can view their
  own profile.

## Run it

```bash
docker compose up
```

That starts Postgres, applies the schema, and seeds the database. Open
http://localhost:3000 and sign in as `admin@mcsholding.com` with the seeded
password (`P@ssw0rd` by default — see [Seeding](#seeding)).

To run the server directly against a local Postgres instead:

```bash
npm install
npm start
```

`JWT_SECRET` must be set for login to work.

## Seeding

`db/seedData.js` holds 144 certifications across 14 employees, carried over
from the original `data/certifications.xlsx` export. It's plain data — the
parser that produced it has been removed, so this file is now the source of
truth for that history.

`docker compose up` runs `db/seed.js` automatically once the app reports
healthy (which is also when the schema has been applied). The seeder is
idempotent: re-running it inserts nothing and never overwrites a password
someone has already chosen, so `docker compose up` is safe to repeat.

To seed manually:

```bash
npm run db:seed
```

Every seeded account — the admin included — starts with the same password and
**must change it on first login**. Override the defaults with
`SEED_DEFAULT_PASSWORD`, `SEED_ADMIN_EMAIL`, and `SEED_ADMIN_NAME`.

Seeded employee emails follow `firstname.lastname@mcsholding.com`. If one is
wrong, fix it in `db/seedData.js` before seeding, or afterwards via the admin
Users tab.

## Schema

`db/schema.sql` defines `users`, `vendors`, and `certificates`. Every
statement in it is idempotent, and the app applies it at boot, so a schema
change ships by editing that file and restarting. To apply it by hand:

```bash
npm run db:migrate
```

Set `SCHEMA_AUTO_APPLY=false` to stop the app applying it at boot (for a
production database where migrations run out of band).

A certificate's `approval_status` is `pending`, `approved`, or `rejected`.
Rejected rows are kept, with the reason, as an audit trail. A partial unique
index (`uq_certificates_active`) allows only one *live* — pending or approved
— row per employee+vendor+certificate, so nobody can double-request something,
while still allowing a re-request after a rejection.

## Expiration handling

Expiry status is computed on every request from the stored date, so it stays
correct day to day with no rewrite job:

- `valid` — more than 90 days away
- `expiring_soon` — within 90 days
- `expired` — the date has passed, or the original sheet said "expired"
- `no_expiration` — the certificate doesn't expire
- `unknown` — no expiration was recorded

The logic is in `lib/certStatus.js`. Older seeded rows carry the original
sheet's free text (`N/A`, `Not Exp`) in `expiration_text` for display.

## API

All routes need `Authorization: Bearer <token>` except `POST /api/auth/login`
and `GET /health`.

| Method | Path | Who | Purpose |
|---|---|---|---|
| `POST` | `/api/auth/login` | anyone | Returns `{token, user}` |
| `POST` | `/api/auth/set-password` | signed in | First-login reset and later changes |
| `GET` | `/api/auth/me` | signed in | Own profile |
| `GET` | `/api/certificates` | signed in | Admins see all, employees see their own. `?approval=pending\|approved\|rejected` |
| `POST` | `/api/certificates` | signed in | Submit a request for yourself (lands `pending`) |
| `GET` | `/api/admin/users` | admin | All users with certificate counts |
| `POST` | `/api/admin/users` | admin | Create a user, returns a one-time temp password |
| `PATCH` | `/api/admin/users/:id` | admin | Update a profile |
| `DELETE` | `/api/admin/users/:id` | admin | Delete a user and their certificates |
| `POST` | `/api/admin/certificates` | admin | Add a certificate for a user (lands `approved`) |
| `POST` | `/api/admin/certificates/:id/approve` | admin | Approve a pending request |
| `POST` | `/api/admin/certificates/:id/reject` | admin | Reject one; `{reason}` is required |
| `DELETE` | `/api/admin/certificates/:id` | admin | Delete a certificate |
| `GET` | `/health` | anyone | Readiness check used by Docker |

Example:

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@mcsholding.com","password":"P@ssw0rd"}' | jq -r .token)

curl -s http://localhost:3000/api/certificates?approval=pending \
  -H "Authorization: Bearer $TOKEN"
```

## Deploying

### AWS Lambda

`Dockerfile.lambda` builds a Lambda container image against AWS's official
Node base image, with `server.handler` as the entry point:

```bash
docker build -f Dockerfile.lambda -t employee-certifications-lambda .
```

The function needs `JWT_SECRET` plus the `DB_*` / `POSTGRES_*` variables
pointing at a reachable Postgres (RDS), and network access to it. Expose it
with a Lambda Function URL or API Gateway — use `AWS_IAM` auth or another
access-control layer in front, since the app's own login is the only barrier
otherwise.

### Plain Node (any VM)

```bash
npm install --omit=dev
JWT_SECRET=... DB_HOST=... node server.js
```

Put it behind a reverse proxy with HTTPS. Since this is HR-adjacent data,
restrict network access as well (VPN or an internal-only network).

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `JWT_SECRET` | _(required)_ | Signing key for session tokens |
| `JWT_EXPIRES_IN` | `8h` | Token lifetime |
| `DB_HOST` | `localhost` | Postgres host (`postgres` inside Compose) |
| `DB_PORT` | `5432` | Postgres port |
| `POSTGRES_USER` | `certificates` | Postgres user |
| `POSTGRES_PASSWORD` | `certificates` | Postgres password |
| `POSTGRES_DB` | `certificates` | Database name |
| `SCHEMA_AUTO_APPLY` | `true` | Apply `db/schema.sql` at boot |
| `SEED_DEFAULT_PASSWORD` | `P@ssw0rd` | Starting password for seeded accounts |
| `SEED_ADMIN_EMAIL` | `admin@mcsholding.com` | Seeded admin's email |
| `SEED_ADMIN_NAME` | `System Administrator` | Seeded admin's display name |

## Project structure

```
server.js                  Express app (also exports a Lambda `handler`)
db/schema.sql              Tables, constraints, indexes — idempotent
db/migrate.js              Applies schema.sql (advisory-locked)
db/seedData.js             The 144 seeded certifications and 14 employees
db/seed.js                 Idempotent seeder
db/connection.js           pg Pool
db/certificatesRepo.js     Certificate queries
db/usersRepo.js            User queries
db/vendorsRepo.js          Vendor lookup/creation
lib/certStatus.js          Expiry status derivation
data/auth/                 Login, tokens, password reset, middleware
data/admin/adminRouter.js  Admin-only routes
data/certificates/         Shared certificate routes
public/                    Frontend (static, no build step)
data/certifications.xlsx   Original source export, kept for reference only
```
