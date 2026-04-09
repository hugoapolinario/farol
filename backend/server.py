import os
import json
import mimetypes
from http.server import HTTPServer, BaseHTTPRequestHandler
from dotenv import load_dotenv
from supabase import create_client

_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
load_dotenv(os.path.join(_PROJECT_ROOT, ".env"))

_SUPABASE_URL = os.getenv("SUPABASE_URL")
_SUPABASE_KEY = os.getenv("SUPABASE_KEY")
_SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY")

# Map clean URLs (same as Vercel rewrites) to files under frontend/
_URL_MAP = {
    "/": os.path.join(_PROJECT_ROOT, "frontend", "landing", "index.html"),
    "/index.html": os.path.join(_PROJECT_ROOT, "frontend", "landing", "index.html"),
    "/signup.html": os.path.join(_PROJECT_ROOT, "frontend", "auth", "signup.html"),
    "/login.html": os.path.join(_PROJECT_ROOT, "frontend", "auth", "login.html"),
    "/confirmed.html": os.path.join(_PROJECT_ROOT, "frontend", "auth", "confirmed.html"),
    "/reset.html": os.path.join(_PROJECT_ROOT, "frontend", "auth", "reset.html"),
    "/update-password.html": os.path.join(_PROJECT_ROOT, "frontend", "auth", "update-password.html"),
    "/app.html": os.path.join(_PROJECT_ROOT, "frontend", "app", "app.html"),
    "/dashboard.html": os.path.join(_PROJECT_ROOT, "frontend", "app", "dashboard.html"),
    "/docs.html": os.path.join(_PROJECT_ROOT, "frontend", "docs", "docs.html"),
}

supabase = create_client(_SUPABASE_URL, _SUPABASE_KEY)
supabase_admin = (
    create_client(_SUPABASE_URL, _SUPABASE_SERVICE_KEY)
    if _SUPABASE_SERVICE_KEY
    else None
)


def _send_json(handler, status: int, obj: dict):
    body = json.dumps(obj).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _cors_json_headers(handler):
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type")
    handler.send_header("Access-Control-Max-Age", "86400")


class Handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        path_only = self.path.split("?", 1)[0]
        if path_only == "/api/ingest":
            self.send_response(204)
            _cors_json_headers(self)
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        path_only = self.path.split("?", 1)[0]
        if path_only != "/api/ingest":
            self.send_response(404)
            self.end_headers()
            return

        if not supabase_admin:
            _send_json(self, 503, {"success": False, "error": "Server misconfigured (missing SUPABASE_SERVICE_KEY)"})
            return

        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            _send_json(self, 400, {"success": False, "error": "Invalid JSON"})
            return

        farol_key = data.get("farol_key")
        if not farol_key:
            _send_json(self, 400, {"success": False, "error": "Missing farol_key"})
            return

        run_obj = data.get("run")
        if "run" in data and not isinstance(run_obj, dict):
            _send_json(self, 400, {"success": False, "error": "run must be a JSON object"})
            return
        if isinstance(run_obj, dict):
            insert_row = dict(run_obj)
        else:
            insert_row = {k: v for k, v in data.items() if k != "farol_key"}

        try:
            key_res = (
                supabase_admin
                .table("api_keys")
                .select("user_id")
                .eq("api_key", farol_key)
                .limit(1)
                .execute()
            )
            rows = key_res.data or []
            user_id = rows[0].get("user_id") if rows else None
        except Exception as e:
            _send_json(self, 500, {"success": False, "error": str(e)})
            return

        if not user_id:
            _send_json(self, 401, {"success": False, "error": "Invalid API key"})
            return

        insert_row["user_id"] = user_id

        try:
            supabase_admin.table("runs").insert(insert_row).execute()
        except Exception as e:
            _send_json(self, 500, {"success": False, "error": str(e)})
            return

        _send_json(self, 200, {"success": True})

    def do_GET(self):
        path_only = self.path.split("?", 1)[0]

        if path_only == "/runs":
            response = supabase.table("runs")\
                .select("*")\
                .order("timestamp", desc=True)\
                .execute()
            data = json.dumps(response.data)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data.encode())
            return

        if path_only in _URL_MAP:
            file_path = _URL_MAP[path_only]
        else:
            rel = path_only.lstrip("/")
            file_path = os.path.join(_PROJECT_ROOT, rel)

        if os.path.isfile(file_path):
            mime_type, _ = mimetypes.guess_type(file_path)
            mime_type = mime_type or "text/plain"
            with open(file_path, "rb") as f:
                content = f.read()
            self.send_response(200)
            self.send_header("Content-Type", mime_type)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(content)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass


if __name__ == "__main__":
    print("[Farol] Server running at http://localhost:8080")
    print("[Farol] Project root:", _PROJECT_ROOT)
    print("[Farol] POST /api/ingest — ingest runs (requires SUPABASE_SERVICE_KEY)")
    HTTPServer(("", 8080), Handler).serve_forever()
