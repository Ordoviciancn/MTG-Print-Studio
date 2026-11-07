import argparse
from concurrent.futures import ThreadPoolExecutor
import io
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import webbrowser

from PIL import Image

from cards import MAX_DECK, SourceError, community_cards, printings, request, resolve
from print_pdf import crop_card, make_pdf

ROOT = Path(__file__).resolve().parent
STATIC = {"/": ("index.html", "text/html"), "/app.js": ("app.js", "text/javascript"),
          "/style.css": ("style.css", "text/css"), "/labels.js": ("labels.js", "text/javascript")}
IMAGE_WORKERS = 4


def download_card(entry):
    (url, ppi), quantity = entry
    data = request(url, limit=32_000_000, accept="image/*")
    with Image.open(io.BytesIO(data)) as image:
        if image.width * image.height > 30_000_000:
            raise ValueError("Card image exceeds 30 megapixels")
        return (url, ppi), crop_card(image, ppi) if ppi else image.copy(), quantity


def pdf_items(payload):
    groups = {}
    copies = 0
    for row in payload["rows"]:
        quantity = row["quantity"]
        faces = row["faces"]
        if type(quantity) is not int or quantity < 1 or not 1 <= len(faces) <= 2:
            raise ValueError("Invalid print quantity or number of faces")
        copies += quantity
        if copies > MAX_DECK:
            raise ValueError("Too many cards")
        for face in faces:
            key = (face["url"], int(face.get("ppi", 0)))
            groups[key] = groups.get(key, 0) + quantity
    entries = list(groups.items())
    with ThreadPoolExecutor(max_workers=IMAGE_WORKERS) as pool:
        for start in range(0, len(entries), IMAGE_WORKERS):
            yield from pool.map(download_card, entries[start:start + IMAGE_WORKERS])


class Handler(BaseHTTPRequestHandler):
    def local_request(self):
        authority = f"127.0.0.1:{self.server.server_port}"
        origin = self.headers.get("Origin")
        return (self.headers.get("Host") == authority
                and origin in (None, f"http://{authority}")
                and self.headers.get("Sec-Fetch-Site") in (None, "none", "same-origin"))

    def send(self, status, data, media, filename=None):
        self.send_response(status)
        self.send_header("Content-Type", media)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, status, value):
        self.send(status, json.dumps(value, ensure_ascii=False).encode(), "application/json; charset=utf-8")

    def do_GET(self):
        if not self.local_request():
            self.send_error(403)
        elif self.path in STATIC:
            name, media = STATIC[self.path]
            self.send(200, (ROOT / name).read_bytes(), media + "; charset=utf-8")
        else:
            self.send_error(404)

    def do_POST(self):
        if not self.local_request() or self.headers.get_content_type() != "application/json":
            self.send_error(403)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 1_000_000:
                raise ValueError("Invalid request size")
            body = json.loads(self.rfile.read(length))
            if self.path == "/api/resolve":
                self.send_json(200, resolve(body["deck"]))
            elif self.path == "/api/prints":
                self.send_json(200, printings(body.get("oracle"), body["name"]))
            elif self.path == "/api/community":
                self.send_json(200, community_cards(body["name"], body["set"], body["number"]))
            elif self.path == "/api/pdf":
                self.send(200, make_pdf(pdf_items(body)), "application/pdf", "mtg-a4.pdf")
            else:
                self.send_error(404)
        except SourceError as error:
            self.send_json(502, {"error": str(error)})
        except (ValueError, KeyError, TypeError, OSError, Image.DecompressionBombError) as error:
            self.send_json(400, {"error": str(error)})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="MTG Print Studio")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    with ThreadingHTTPServer(("127.0.0.1", args.port), Handler) as server:
        url = f"http://127.0.0.1:{server.server_port}"
        print(f"MTG Print Studio: {url}", flush=True)
        if not args.no_browser:
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
