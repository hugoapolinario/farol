# Farol (vigil)

Monorepo layout:

| Path | Contents |
|------|----------|
| `frontend/` | All HTML (landing, auth, app, docs) |
| `backend/` | `server.py` (local dev), `build.js` (Vercel → root `config.js`) |
| `sdk/` | Local prototype Python SDK (`@trace`), `agent.py`, `check.py` |
| `farol-sdk/` | Published **farol-sdk** PyPI package (unchanged) |

**Root:** `.env`, `config.js` (generated), `vercel.json`, `runs.json`, `SKILL.md`.

Local dev: `python backend/server.py` → http://localhost:8080 — same routes as production (`/`, `/app.html`, `/config.js`, `/runs`).
