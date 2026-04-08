import os
import json
import mimetypes
from http.server import HTTPServer, BaseHTTPRequestHandler
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

supabase = create_client(
    os.getenv("SUPABASE_URL"),
    os.getenv("SUPABASE_KEY")
)

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/runs":
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
        else:
            path = self.path.lstrip("/") or "index.html"
            if os.path.exists(path):
                mime_type, _ = mimetypes.guess_type(path)
                mime_type = mime_type or "text/plain"
                with open(path, "rb") as f:
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
    HTTPServer(("", 8080), Handler).serve_forever()