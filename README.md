# ApparelFlow ERP — Cutting Gatekeeper Verification Terminal

Split architecture: **React (Vite)** frontend on Vercel, **Node.js + Express** API on Railway/Render, **PostgreSQL on Supabase**.

```
frontend/  React SPA  --HTTPS + JWT-->  backend/  Express API  --SQL (pg)-->  Supabase Postgres
```

## Demo credentials (password for all: `Demo@1234`)
| Role | Email |
|---|---|
| Cutting Supervisor | supervisor@apparelflow.test |
| Cutting Verifier | verifier@apparelflow.test |
| Sewing Supervisor | sewing@apparelflow.test |
The login page also has a one-click Demo Credential Panel.

## Run locally
```
cd backend && cp .env.example .env   # fill DATABASE_URL (Supabase) and JWT_SECRET
npm install && npm start             # http://localhost:3000 (tables + seed data are created automatically)
cd ../frontend && cp .env.example .env
npm install && npm run dev           # http://localhost:5173
```
Tests: `cd backend && npm test` (set `TEST_DATABASE_URL` to a throwaway database, e.g. a second Supabase project or local Postgres; the tests create orders).

## Deploy
1. **Supabase**: create a project, then Project Settings > Database > Connection string > *Session pooler* URI. That is `DATABASE_URL`.
2. **Backend (Railway)**: New Project > Deploy from GitHub, set Root Directory to `backend`. Variables: `DATABASE_URL`, `JWT_SECRET` (long random string), `CLIENT_ORIGIN` (your Vercel URL, no trailing slash). Generate a public domain. Check `https://<backend>/api/health`.
3. **Frontend (Vercel)**: Import the repo, set Root Directory to `frontend`, Framework Vite. Variable: `VITE_API_URL=https://<your-railway-domain>`. Deploy.

## Security design (all enforced on the server)
- Signed JWT on every request; role checked per endpoint (401 no token, 403 wrong role).
- Approve returns **422** if any component is RED or uncounted; reject without a note returns 400.
- Traffic-light status, wastage %, verifier ID and timestamp are computed server-side, never read from the request body.
- `GET /api/sewing/queue` uses `WHERE status = 'VERIFIED'` in SQL and ignores query params.
- `verification_logs` is immutable (Postgres trigger blocks UPDATE/DELETE). State changes use conditional updates so a double-submit cannot apply twice.

## Schema
users, recipes, recipe_components, cutting_orders, verification_items, verification_logs (see `SCHEMA` in `backend/server.js`).
