## Hosted backend (server + Postgres)

This repo now includes a standalone hosted backend in `server/` and a Postgres schema that supports **multiple businesses** (multi-tenant) via `Business` + `businessId` on all data.

### What runs where

- **Hosted backend**: `server/` (Express + Prisma + Postgres)
- **Electron POS app**: unchanged UI, but can connect to cloud when configured

### Local development (recommended)

1. Start Docker Desktop (required for Postgres container).
2. Start Postgres + API with docker compose:

```bash
docker compose up -d
```

3. Apply migrations and generate Prisma client (inside `server/`):

```bash
cd server
npx prisma generate
npx prisma migrate deploy
```

4. Run the API in dev mode:

```bash
cd server
npm run dev
```

API health check: `GET http://localhost:8080/health`

### Google Cloud hosting

See: `docs/GOOGLE_CLOUD_DEPLOYMENT.md`

### Environment variables (server)

Set these in your hosting platform (or in docker-compose `environment:`):

- Example file: `server/env.example`

- **DATABASE_URL**: Postgres connection string (required)
  - Example: `postgres://pos:pos@localhost:5432/pos`
- **JWT_SECRET**: secret for signing tokens (required, >= 32 chars)
- **PORT**: HTTP port (default `8080`)
- **CORS_ORIGINS**: comma-separated allowlist for browser clients (optional)
  - Example: `https://your-admin-domain.com,https://your-pos-domain.com`

### Tenant / business onboarding

Create a new business + first admin user:

- `POST /auth/register-business`

Body example:

```json
{
  "businessName": "My Restaurant",
  "businessCode": "MYRESTAURANT",
  "businessPassword": "SOME_STRONG_PASSWORD",
  "adminName": "Owner",
  "adminPin": "1234",
  "adminEmail": "owner@example.com"
}
```

Notes:
- `businessPassword` is a provider-supplied shared secret used to access certain public endpoints (e.g. staff list / open shifts) so the tenant cannot be enumerated by Business code alone.
- The backend stores only a hash; you must store this password securely and provide it to the restaurant owner/admin.

Login (PIN-based):

- `POST /auth/login`

Body example:

```json
{
  "businessCode": "MYRESTAURANT",
  "pin": "1234",
  "userId": 1
}
```

### Electron app: connect to cloud

In the Electron Admin panel:

- **Admin → Settings → Cloud (Hosted)**:
  - **Backend URL**: e.g. `http://localhost:8080` or `https://api.yourdomain.com`
  - **Business code**: e.g. `MYRESTAURANT`

When set, the Electron app will proxy these operations to the hosted backend:

- staff list + staff management
- menu categories/sync
- shifts
- tickets

Printing remains local (ESC/POS from the POS machine).

