# Frontend

Static HTML for **Farol** (marketing, auth, app dashboard, docs). Deployed at the site root via URL rewrites (see root `vercel.json`): e.g. `/` → `frontend/landing/index.html`, `/login.html` → `frontend/auth/login.html`.

## Layout

| Path | Purpose |
|------|---------|
| `landing/` | Marketing homepage (`index.html`) |
| `auth/` | Sign up, login, password reset, update password |
| `app/` | Logged-in dashboard (`app.html`) and legacy `dashboard.html` |
| `docs/` | Documentation (`docs.html`) |

Shared assets: Supabase client loads from `/config.js` (generated at repo root at build time). Use **root-absolute** links (`/login.html`, `/app.html`) so navigation works regardless of file path.
