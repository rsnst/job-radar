"""Local dev server with HTTP Range support (python -m http.server lacks it; the app needs it).

    python scripts/serve.py site 8000
"""
import os, re, sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from functools import partial

class H(SimpleHTTPRequestHandler):
    def send_head(self):
        rng = self.headers.get("Range")
        path = self.translate_path(self.path)
        if not rng or not os.path.isfile(path):
            return super().send_head()
        m = re.match(r"bytes=(\d+)-(\d*)", rng)
        size = os.path.getsize(path)
        start = int(m.group(1)); end = min(int(m.group(2) or size - 1), size - 1)
        f = open(path, "rb"); f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        self._remaining = end - start + 1
        return f
    def copyfile(self, src, dst):
        n = getattr(self, "_remaining", None)
        if n is None:
            return super().copyfile(src, dst)
        dst.write(src.read(n)); self._remaining = None

if __name__ == "__main__":
    root = sys.argv[1] if len(sys.argv) > 1 else "site"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8000
    print(f"http://localhost:{port}")
    ThreadingHTTPServer(("", port), partial(H, directory=root)).serve_forever()
