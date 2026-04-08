import os
import json
import mimetypes
from http.server import HTTPServer, BaseHTTPRequestHandler
from dotenv import load_dotenv
from supabase import create_client

_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
load_dotenv(os.path.join(_PROJECT_ROOT, ".env"))

# Map clean URLs (same as Vercel rewrites) to files under frontend/
_URL_MAP = {
    "/": os.path.join(_PROJECT_ROOT, "frontend", "landing", "index.html"),
    "/index.html": os.path.join(_PROJECT_ROOT, "frontend", "landing", "index.html"),
    "/signup.html": os.path.join(_PROJECT_ROOT, "frontend", "auth", "signup.html"),
    "/login.html": os.path.join(_PROJECT_ROOT, "frontend", "auth", "login.html"),
    "/reset.html": os.path.join(_PROJECT_ROOT, "frontend", "auth", "reset.html"),
    "/update-password.html": os.path.join(_PROJECT_ROOT, "frontend", "auth", "update-password.html"),
    "/app.html": os.path.join(_PROJECT_ROOT, "frontend", "app", "app.html"),
    "/dashboard.html": os.path.join(_PROJECT_ROOT, "frontend", "app", "dashboard.html"),
    "/docs.html": os.path.join(_PROJECT_ROOT, "frontend", "docs", "docs.html"),
}

supabase = create_client(
    os.getenv("SUPABASE_URL"),
    os.getenv("SUPABASE_KEY")
)


class Handler(BaseHTTPRequestHandler):
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
    HTTPServer(("", 8080), Handler).serve_forever()
