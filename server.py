import os
import json
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

        elif self.path == "/" or self.path == "/dashboard.html":
            with open("dashboard.html", "rb") as f:
                content = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(content)

        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass

if __name__ == "__main__":
    print("[Vigil] Server running at http://localhost:8080")
    print("[Vigil] Dashboard at http://localhost:8080/dashboard.html")
    HTTPServer(("", 8080), Handler).serve_forever()