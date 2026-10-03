"""Local demo UI for the share-proof image pipeline. Not part of the bot."""
from __future__ import annotations

import cgi
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from pipeline import analyze, load_bgr

ROOT = Path(__file__).resolve().parent
EVAL = Path("/workspaces/zalo_barobot/tests/eval_datasets")
STATIC = ROOT / "static" / "index.html"
MAX_BYTES = 12 * 1024 * 1024


def eval_names() -> list[str]:
    names = []
    for path in EVAL.rglob("*"):
        if path.is_file() and path.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}:
            names.append(str(path.relative_to(EVAL)))
    return sorted(names)


def read_eval(name: str) -> bytes:
    path = (EVAL / name).resolve()
    root = EVAL.resolve()
    if path != root and root not in path.parents:
        raise FileNotFoundError(name)
    if not path.is_file():
        raise FileNotFoundError(name)
    return path.read_bytes()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        print("[demo]", fmt % args)

    def _send(self, code: int, body: bytes, content_type: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, payload: dict) -> None:
        self._send(code, json.dumps(payload).encode(), "application/json")

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/":
            self._send(200, STATIC.read_bytes(), "text/html; charset=utf-8")
            return
        if path == "/api/presets":
            self._json(200, {"images": eval_names()})
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length", "0"))
        if length > 80 * 1024 * 1024:
            self._json(413, {"error": "body too large"})
            return
        raw = self.rfile.read(length)
        try:
            if path == "/api/run-preset":
                body = json.loads(raw.decode())
                sample_name = body["sample"]
                names = body.get("submissions") or [n for n in eval_names() if n != sample_name]
                sample = load_bgr(read_eval(sample_name))
                subs = [(n, load_bgr(read_eval(n))) for n in names]
            elif path == "/api/run":
                sample, subs = _read_upload(self.headers, raw)
            else:
                self._json(404, {"error": "not found"})
                return
            if not subs:
                self._json(400, {"error": "no submissions"})
                return
            self._json(200, analyze(sample, subs))
        except FileNotFoundError as exc:
            self._json(404, {"error": f"unknown image {exc}"})
        except Exception as exc:  # noqa: BLE001 — demo returns the message
            self._json(400, {"error": str(exc)})


def _read_upload(headers, raw: bytes):
    import io
    form = cgi.FieldStorage(
        fp=io.BytesIO(raw),
        headers=headers,
        environ={
            "REQUEST_METHOD": "POST",
            "CONTENT_TYPE": headers.get("Content-Type", ""),
            "CONTENT_LENGTH": str(len(raw)),
        },
    )
    sample_item = form["sample"] if "sample" in form else None
    if sample_item is not None and getattr(sample_item, "file", None) and sample_item.filename:
        sample = load_bgr(_file_bytes(sample_item))
    elif "sample_preset" in form:
        sample = load_bgr(read_eval(form.getfirst("sample_preset")))
    else:
        raise ValueError("choose a sample photo")
    subs = []
    if "submission" in form:
        items = form["submission"]
        if not isinstance(items, list):
            items = [items]
        for item in items:
            if item.filename:
                subs.append((item.filename, load_bgr(_file_bytes(item))))
    for name in form.getlist("submission_preset"):
        subs.append((name, load_bgr(read_eval(name))))
    return sample, subs


def _file_bytes(item) -> bytes:
    data = item.file.read()
    if len(data) > MAX_BYTES:
        raise ValueError(f"{item.filename} is over 12MB")
    if not data:
        raise ValueError(f"{item.filename} is empty")
    return data


def main() -> None:
    server = ThreadingHTTPServer(("0.0.0.0", 8765), Handler)
    print("demo http://127.0.0.1:8765")
    server.serve_forever()


if __name__ == "__main__":
    main()
