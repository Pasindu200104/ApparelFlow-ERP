# AI Optimization Report

## 1. Tools & Prompting
**Tools used:** Claude (Sonnet 5.5) via chat.

| Task | What I asked the AI to do | What I decided myself |
|---|---|---|
| Architecture | Generate the full-stack project from the brief | Chose to split into React frontend + Express backend, and to use Supabase Postgres instead of SQLite |
| Schema & seed data | Design the 6 tables and seed the two recipes | I reviewed 6 tables found no problems |
| API & security | Write the endpoints, role checks, hard stop 
| Tests | Generate the 5 required tests + 1 extra | 
| UI | Generate the interface and styling | Design was good enoughf so nothing changed 

**How I prompted:** I Couldn't start the project as expected becuase of a personal reason, so the time was limited so asked AI to build complete project providing the pdf, it created the progect but the project structure was not suitable to host in vercel or railway so i had to pompt it and divide it into 2 folders one for frontend and one for back end that way i can easilly host front end in vercel and backend in railway.

## 2. Flawed / Broken AI Code

**Issue 1: Test script failed.** The generated `npm test` command pointed at a folder, and Node's test runner could not load it, so zero tests ran. Fixed by pointing the script at the test file.

**Issue 2: SQLite chosen for a cloud deployment.** The first version used SQLite, which loses its data on serverless hosts like Vercel. That would have broken the "data persists after refresh" requirement, so I moved to Supabase Postgres, which meant rewriting the data layer to be async.


## 3. Defensive Architecture
**State machine:** `PENDING_VERIFICATION → VERIFIED` or `→ REJECTED → (resubmit) → PENDING_VERIFICATION`. Every transition is checked on the server, and the database update only applies if the order is still in the expected status, so a double-click or replayed request returns 409.

**Guards:**
- Authentication: every request carries a signed token; the role comes from the token, never from the request body. No token → 401, wrong role → 403.
- Hard stop: on approve, the server re-reads the saved counts from the database. Any RED or uncounted component → 422. The disabled button is only a convenience.
- Rejection requires a non-empty note (400 otherwise).
- Traffic-light status, wastage %, verifier ID, and timestamp are all computed on the server.
- Sewing queue uses `WHERE status = 'VERIFIED'` in SQL and ignores URL params.
- Audit log: a database trigger blocks any UPDATE or DELETE on `verification_logs`.
- Input validation: whole numbers only for counts and quantities, enforced on both client and server.

**What I would improve with more time:** i would optimize the speed and rate limiting.