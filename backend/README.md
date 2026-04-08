# Backend

Small **Python** and **Node** utilities for local dev and deployment.

| File | Role |
|------|------|
| `server.py` | Dev HTTP server on port **8080**: `GET /runs` (JSON from Supabase), static files with the same URL map as Vercel (serves `frontend/**`). Run from repo root: `python backend/server.py` |
| `build.js` | Vercel build step: reads `SUPABASE_URL` / `SUPABASE_KEY` from the environment and writes **`config.js`** at the **repository root** for the frontend. Invoked as `node backend/build.js` (see `vercel.json`). |

Environment: load `.env` from the repo root (server uses `python-dotenv`).
