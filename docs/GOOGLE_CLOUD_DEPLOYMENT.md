## Google Cloud deployment (Cloud Run + Cloud SQL Postgres)

This guide hosts the POS backend (`server/`) on Google Cloud and uses Cloud SQL Postgres as the database.

### Prereqs

- Google Cloud project created
- Billing enabled
- `gcloud` installed and authenticated:

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
```

Enable APIs:

```bash
gcloud services enable run.googleapis.com sqladmin.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com
```

### 1) Create Cloud SQL Postgres

```bash
gcloud sql instances create pos-sql \
  --database-version=POSTGRES_16 \
  --region=YOUR_REGION \
  --cpu=1 --memory=3840MB \
  --storage-size=10GB --storage-type=SSD
```

Create database + user:

```bash
gcloud sql databases create pos --instance=pos-sql
gcloud sql users create pos --instance=pos-sql --password='CHOOSE_A_STRONG_PASSWORD'
```

### 2) Build and deploy server to Cloud Run

From repo root, deploy the backend (build from source):

```bash
gcloud run deploy pos-api \
  --source ./server \
  --region YOUR_REGION \
  --allow-unauthenticated \
  --set-env-vars PORT=8080 \
  --set-env-vars JWT_SECRET='CHOOSE_A_LONG_RANDOM_SECRET_32PLUS_CHARS'
```

> Note: we allow unauthenticated because `/health`, `/auth/register-business`, `/auth/login`, and `/auth/public-users` are public endpoints. All other endpoints require JWT.

### 3) Connect Cloud Run to Cloud SQL

Cloud Run connects to Cloud SQL via Cloud SQL connector.

1) Get your Cloud SQL connection name:

```bash
gcloud sql instances describe pos-sql --format='value(connectionName)'
```

2) Update the Cloud Run service to attach Cloud SQL and set `DATABASE_URL`:

```bash
CONN_NAME="$(gcloud sql instances describe pos-sql --format='value(connectionName)')"

gcloud run services update pos-api \
  --region YOUR_REGION \
  --add-cloudsql-instances "$CONN_NAME" \
  --set-env-vars DATABASE_URL="postgresql://pos:CHOOSE_A_STRONG_PASSWORD@/pos?host=/cloudsql/$CONN_NAME"
```

### 4) Run Prisma migrations in production

You must apply migrations to Cloud SQL. Options:

- **Option A (recommended): Cloud Build job / one-off migration runner**
  - Create a small Cloud Run job (or Cloud Build step) that runs:
    - `npx prisma migrate deploy`

- **Option B: run locally via Cloud SQL Auth Proxy**
  - Start the proxy and point `DATABASE_URL` to `localhost`, then run `npx prisma migrate deploy` from `server/`.

### 5) Configure the Electron POS app (no custom backend URLs)

The app must be built with the backend URL baked in via env:

- Set `POS_CLOUD_URL` to your Cloud Run URL at build time
- Distribute the app; the business only enters its **Business code** in Admin Settings.

Example Cloud Run URL:
- After deploy, find it with:

```bash
gcloud run services describe pos-api --region YOUR_REGION --format='value(status.url)'
```

### 6) First business onboarding

Call `POST /auth/register-business` against your Cloud Run URL to create the first business + admin.

Then in the POS app:
- Admin → Settings → Cloud (Hosted) → enter that `Business code`.

