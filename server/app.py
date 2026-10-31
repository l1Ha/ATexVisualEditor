"""
ATexVisualEditor — HTTP server.

A single-file, standard-library HTTP service that:
  * serves the web application from `web/`,
  * stores projects as directories under `projects/`,
  * compiles LaTeX with the machine's own TeX distribution,
  * renders PDF pages to SVG/PNG and answers SyncTeX queries,
  * renders individual math snippets with the user's preamble.

Binding defaults to 127.0.0.1.  Use `--host 0.0.0.0` to reach the editor from
another device on the network (a tablet, a phone, another machine) — the whole
point of a browser-based editor is that any device with a browser is a client.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import posixpath
import re
import socket
import sys
import threading
import time
import traceback
import urllib.parse
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

if __package__ in (None, ""):  # allow `python3 server/app.py`
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from server import templates  # type: ignore
    from server.compiler import TOOLCHAIN, Builder, CompileError, render_math_svg  # type: ignore
    from server.projects import MAX_UPLOAD, ProjectError, ProjectStore, is_text_file  # type: ignore
else:
    from . import templates
    from .compiler import TOOLCHAIN, Builder, CompileError, render_math_svg
    from .projects import MAX_UPLOAD, ProjectError, ProjectStore, is_text_file

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WEB_DIR = os.path.join(ROOT, "web")
VERSION = "1.0.0"

# A tiny cache so repeated math previews while typing are instant.
_math_cache: dict[str, str | None] = {}
_math_cache_lock = threading.Lock()


class ApiError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


class App:
    """Application state shared by every request handler."""

    def __init__(self, projects_root: str, *, open_browser: bool = False) -> None:
        self.store = ProjectStore(projects_root)
        self.projects_root = self.store.root
        self.started_at = time.time()
        self.builds_in_flight: dict[str, float] = {}
        self._build_log_ring: list[str] = []

    def log(self, message: str) -> None:
        stamp = time.strftime("%H:%M:%S")
        line = f"[{stamp}] {message}"
        print(line, flush=True)
        self._build_log_ring.append(line)
        if len(self._build_log_ring) > 200:
            del self._build_log_ring[:-200]


APP: App | None = None


# ---------------------------------------------------------------------------
# Request handling
# ---------------------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    server_version = f"ATexVisualEditor/{VERSION}"
    protocol_version = "HTTP/1.1"

    # -- plumbing ------------------------------------------------------------

    def log_message(self, fmt: str, *args: Any) -> None:  # quieter default logging
        if APP and os.environ.get("ATEX_VERBOSE"):
            APP.log(f"{self.address_string()} {fmt % args}")

    def _send(self, status: int, body: bytes, content_type: str, *, headers: dict[str, str] | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if headers:
            for key, value in headers.items():
                self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _json(self, data: Any, status: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False, default=_json_default).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8")

    def _error(self, status: int, message: str, *, detail: str = "") -> None:
        self._json({"error": message, "detail": detail}, status)

    def _read_body(self) -> bytes:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ApiError(400, "invalid Content-Length")
        if length > MAX_UPLOAD:
            raise ApiError(413, f"upload larger than {MAX_UPLOAD // (1024 * 1024)} MB")
        if length <= 0:
            return b""
        remaining = length
        chunks: list[bytes] = []
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 1 << 20))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def _read_json(self) -> dict[str, Any]:
        raw = self._read_body()
        if not raw:
            return {}
        try:
            data = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as exc:
            raise ApiError(400, f"invalid JSON body: {exc}") from exc
        if not isinstance(data, dict):
            raise ApiError(400, "expected a JSON object")
        return data

    # -- HTTP verbs ----------------------------------------------------------

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_HEAD(self) -> None:
        self._dispatch("GET")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def do_PUT(self) -> None:
        self._dispatch("PUT")

    def do_DELETE(self) -> None:
        self._dispatch("DELETE")

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Allow", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _dispatch(self, method: str) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(parsed.path)
        query = {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()}
        try:
            if path.startswith("/api/"):
                self._api(method, path, query)
            else:
                self._static(path)
        except ApiError as exc:
            self._error(exc.status, exc.message)
        except ProjectError as exc:
            self._error(404, str(exc))
        except CompileError as exc:
            self._error(422, str(exc))
        except BrokenPipeError:
            pass
        except Exception as exc:  # noqa: BLE001 — a local tool should never die
            APP and APP.log(f"unhandled error on {method} {path}: {exc}")
            self._error(500, "internal error", detail=traceback.format_exc(limit=6))

    # -- static files --------------------------------------------------------

    def _static(self, path: str) -> None:
        rel = path.lstrip("/") or "index.html"
        target = os.path.normpath(os.path.join(WEB_DIR, rel))
        if not target.startswith(WEB_DIR):
            raise ApiError(403, "forbidden")
        if os.path.isdir(target):
            target = os.path.join(target, "index.html")
        if not os.path.isfile(target):
            # Single-page app: unknown paths fall back to the shell.
            if "." not in posixpath.basename(rel):
                target = os.path.join(WEB_DIR, "index.html")
            else:
                raise ApiError(404, f"not found: {rel}")
        with open(target, "rb") as fh:
            body = fh.read()
        ctype = mimetypes.guess_type(target)[0] or "application/octet-stream"
        if target.endswith(".js"):
            ctype = "text/javascript; charset=utf-8"
        elif target.endswith(".css"):
            ctype = "text/css; charset=utf-8"
        elif target.endswith(".svg"):
            ctype = "image/svg+xml"
        elif target.endswith(".woff2"):
            ctype = "font/woff2"
        elif target.endswith(".html"):
            ctype = "text/html; charset=utf-8"
        headers = {"Content-Length": str(len(body))}
        if "/vendor/" in target:
            headers["Cache-Control"] = "public, max-age=604800"
        self._send(200, body, ctype, headers=headers)

    # -- API -----------------------------------------------------------------

    def _api(self, method: str, path: str, query: dict[str, str]) -> None:
        assert APP is not None
        parts = [p for p in path[len("/api/") :].split("/") if p]

        # /api/status
        if parts == ["status"]:
            return self._json(
                {
                    "version": VERSION,
                    "toolchain": TOOLCHAIN.to_json(),
                    "projectsDir": APP.projects_root,
                    "python": sys.version.split()[0],
                    "uptime": int(time.time() - APP.started_at),
                    "templates": templates.TEMPLATE_INFO,
                }
            )

        # /api/math/svg
        if parts == ["math", "svg"] and method == "POST":
            body = self._read_json()
            latex = str(body.get("latex") or "")
            display = bool(body.get("display"))
            preamble = str(body.get("preamble") or "")[:4000]
            key = f"{display}|{preamble}|{latex}"
            with _math_cache_lock:
                if key in _math_cache:
                    cached = _math_cache[key]
                    return self._json({"svg": cached, "cached": True})
            svg = render_math_svg(latex, display=display, preamble=preamble)
            with _math_cache_lock:
                if len(_math_cache) > 400:
                    _math_cache.clear()
                _math_cache[key] = svg
            return self._json({"svg": svg, "cached": False})

        # /api/projects ...
        if parts and parts[0] == "projects":
            return self._projects(method, parts[1:], query)

        raise ApiError(404, f"unknown endpoint: {path}")

    def _projects(self, method: str, parts: list[str], query: dict[str, str]) -> None:
        assert APP is not None
        store = APP.store

        # /api/projects
        if not parts:
            if method == "GET":
                return self._json({"projects": store.list(), "projectsDir": store.root})
            if method == "POST":
                body = self._read_json()
                name = str(body.get("name") or "Untitled").strip()[:120] or "Untitled"
                template = str(body.get("template") or "article")
                content = body.get("content")
                project = store.create(
                    name,
                    template,
                    content=str(content) if isinstance(content, str) else None,
                )
                APP.log(f"created project {project.id}")
                return self._json(project.to_json(), 201)
            raise ApiError(405, "method not allowed")

        # /api/projects/import  (zip upload)
        if len(parts) == 1 and parts[0] == "import" and method == "POST":
            name = query.get("name") or "Imported project"
            data = self._read_body()
            if not data:
                raise ApiError(400, "empty upload")
            project = store.create(name, "blank")
            count = project.import_zip(data)
            project.save_settings({"mainFile": project.detect_main_file()})
            APP.log(f"imported {count} files into {project.id}")
            return self._json(project.to_json(), 201)

        pid = parts[0]
        project = store.open(pid)
        rest = parts[1:]

        # /api/projects/<id>
        if not rest:
            if method == "GET":
                return self._json(project.to_json())
            if method == "DELETE":
                store.delete(pid)
                APP.log(f"deleted project {pid}")
                return self._json({"deleted": pid})
            if method == "PUT":
                settings = project.save_settings(self._read_json())
                return self._json({"settings": settings, "files": project.tree()})
            raise ApiError(405, "method not allowed")

        head = rest[0]

        # /api/projects/<id>/tree
        if head == "tree" and method == "GET":
            return self._json(
                {
                    "files": project.tree(),
                    "settings": project.load_settings(),
                    "mainFile": project.detect_main_file(),
                }
            )

        # /api/projects/<id>/file?path=...
        if head == "file":
            rel = query.get("path", "")
            if method == "GET":
                path = project.safe_path(rel)
                if not os.path.isfile(path):
                    raise ProjectError(f"no such file: {rel}")
                with open(path, "rb") as fh:
                    data = fh.read()
                if is_text_file(rel) or b"\x00" not in data[:4096]:
                    return self._json({"path": rel, "content": data.decode("utf-8", "replace"), "binary": False})
                return self._json({"path": rel, "content": "", "binary": True, "size": len(data)})
            if method in ("PUT", "POST"):
                body = self._read_json()
                content = body.get("content")
                if content is None:
                    raise ApiError(400, "missing “content”")
                size = project.write_text(rel, str(content))
                return self._json({"path": rel, "size": size})
            if method == "DELETE":
                project.delete(rel)
                return self._json({"deleted": rel})
            raise ApiError(405, "method not allowed")

        # /api/projects/<id>/mkdir
        if head == "mkdir" and method == "POST":
            project.mkdir(str(self._read_json().get("path") or ""))
            return self._json({"files": project.tree()})

        # /api/projects/<id>/rename
        if head == "rename" and method == "POST":
            body = self._read_json()
            project.rename(str(body.get("from") or ""), str(body.get("to") or ""))
            return self._json({"files": project.tree()})

        # /api/projects/<id>/upload?path=dir
        if head == "upload" and method == "POST":
            rel = query.get("path", "")
            data = self._read_body()
            if not data:
                raise ApiError(400, "empty upload")
            size = project.write_bytes(rel, data)
            APP.log(f"uploaded {rel} ({size} bytes) to {pid}")
            return self._json({"path": rel, "size": size, "files": project.tree()})

        # /api/projects/<id>/raw?path=...  (binary asset for <img>/<iframe>)
        if head == "raw" and method == "GET":
            rel = query.get("path", "")
            path = project.safe_path(rel)
            if not os.path.isfile(path):
                raise ProjectError(f"no such file: {rel}")
            ext = os.path.splitext(rel)[1].lower()
            # PDF/EPS cannot be shown by browsers: rasterise the first page so
            # figures still preview inside the visual editor.
            if ext in (".pdf", ".eps", ".ps"):
                png = _rasterise_first_page(project, path, query)
                if png:
                    return self._send(200, png, "image/png", headers={"Cache-Control": "max-age=60"})
                raise ApiError(415, f"cannot preview {ext} files without a PDF renderer installed")
            with open(path, "rb") as fh:
                data = fh.read()
            ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
            if ext == ".svg":
                ctype = "image/svg+xml"
            return self._send(200, data, ctype, headers={"Cache-Control": "max-age=60"})

        # /api/projects/<id>/compile
        if head == "compile" and method == "POST":
            body = self._read_json()
            settings = project.load_settings()
            engine = str(body.get("engine") or settings.get("engine") or TOOLCHAIN.default_engine)
            main_file = str(body.get("main") or settings.get("mainFile") or project.detect_main_file())
            if not main_file:
                raise ApiError(400, "no main file — create a .tex file with \\documentclass first")
            builder = Builder(project.dir)
            APP.builds_in_flight[pid] = time.time()
            APP.log(f"building {pid}/{main_file} with {engine}")
            try:
                result = builder.build(
                    main_file,
                    engine,
                    synctex=bool(body.get("synctex", True)),
                    timeout=int(body.get("timeout") or settings.get("timeout") or 180),
                    shell_escape=bool(body.get("shellEscape", settings.get("shellEscape", False))),
                )
            finally:
                APP.builds_in_flight.pop(pid, None)
            APP.log(
                f"build {result.build_id} {'ok' if result.ok else 'failed'} "
                f"in {result.duration_ms}ms ({result.pages} pages, "
                f"{len(result.diagnostics)} diagnostics)"
            )
            payload = result.to_json()
            payload["pdfUrl"] = f"/api/projects/{pid}/pdf?build={result.build_id}"
            payload["pages"] = result.pages
            # The .aux file is what turns \ref{fig:x} into "1" in the visual
            # editor, so the labels stay meaningful without a second request.
            payload["aux"] = _read_aux(project, result)
            if body.get("includeLog", True):
                payload["log"] = result.log
            return self._json(payload)

        # /api/projects/<id>/pdf
        if head == "pdf" and method == "GET":
            build_id = query.get("build") or project.last_build_id()
            if not build_id:
                raise ApiError(404, "no build yet — compile the document first")
            settings = project.load_settings()
            builder = Builder(project.dir)
            pdf = builder._find_output(settings.get("mainFile", "main.tex"), builder.build_dir(build_id), ".pdf")
            if not pdf or not os.path.isfile(pdf):
                raise ApiError(404, "this build has no PDF")
            with open(pdf, "rb") as fh:
                data = fh.read()
            download = query.get("download") == "1"
            filename = os.path.basename(pdf)
            headers = {
                "Cache-Control": "no-cache",
                "Content-Disposition": f'{"attachment" if download else "inline"}; filename="{filename}"',
            }
            return self._send(200, data, "application/pdf", headers=headers)

        # /api/projects/<id>/page/<n>.svg | .png
        if head == "page" and rest[1:] and method == "GET":
            target = rest[1]
            m = re.match(r"^(\d+)\.(svg|png)$", target)
            if not m:
                raise ApiError(400, "expected a page like 3.svg or 3.png")
            page = int(m.group(1))
            kind = m.group(2)
            build_id = query.get("build") or project.last_build_id()
            if not build_id:
                raise ApiError(404, "no build yet")
            settings = project.load_settings()
            builder = Builder(project.dir)
            main_file = settings.get("mainFile", "main.tex")
            if page < 1 or page > 5000:
                raise ApiError(400, "page out of range")
            if kind == "svg":
                data = builder.page_svg(build_id, page, main_file)
                if data is None:
                    # Fall back to a high-resolution bitmap.
                    data = builder.page_png(build_id, page, main_file, dpi=int(query.get("dpi") or 150))
                    if data is None:
                        raise ApiError(404, f"cannot render page {page}")
                    return self._send(200, data, "image/png", headers={"Cache-Control": "max-age=300"})
                return self._send(200, data, "image/svg+xml", headers={"Cache-Control": "max-age=300"})
            dpi = max(36, min(400, int(query.get("dpi") or 110)))
            data = builder.page_png(build_id, page, main_file, dpi=dpi)
            if data is None:
                raise ApiError(404, f"cannot render page {page}")
            return self._send(200, data, "image/png", headers={"Cache-Control": "max-age=300"})

        # /api/projects/<id>/builds
        if head == "builds" and method == "GET":
            builder = Builder(project.dir)
            root = builder.build_root
            builds: list[dict[str, Any]] = []
            if os.path.isdir(root):
                for name in sorted(os.listdir(root), reverse=True):
                    path = os.path.join(root, name)
                    if os.path.isdir(path):
                        builds.append(
                            {
                                "buildId": name,
                                "mtime": os.path.getmtime(path),
                                "pdf": os.path.isfile(builder._find_output("main.tex", path, ".pdf") or ""),
                            }
                        )
            return self._json({"builds": builds, "latest": project.last_build_id()})

        # /api/projects/<id>/synctex
        if head == "synctex" and method == "POST":
            body = self._read_json()
            build_id = str(body.get("build") or project.last_build_id() or "")
            if not build_id:
                raise ApiError(409, "no build available for SyncTeX — compile first")
            settings = project.load_settings()
            builder = Builder(project.dir)
            main_file = settings.get("mainFile", "main.tex")
            if body.get("direction") == "inverse":
                hit = builder.synctex_inverse(
                    build_id,
                    main_file,
                    int(body.get("page") or 1),
                    float(body.get("x") or 0),
                    float(body.get("y") or 0),
                )
                return self._json({"hit": hit})
            hits = builder.synctex_forward(
                build_id,
                main_file,
                str(body.get("file") or main_file),
                int(body.get("line") or 1),
                int(body.get("column") or 0),
            )
            return self._json({"hits": hits})

        # /api/projects/<id>/export
        if head == "export" and method == "GET":
            data = project.zip_bytes()
            headers = {
                "Content-Disposition": f'attachment; filename="{pid}.zip"',
                "Cache-Control": "no-cache",
            }
            return self._send(200, data, "application/zip", headers=headers)

        # /api/projects/<id>/duplicate
        if head == "duplicate" and method == "POST":
            copy = APP.store.duplicate(pid)
            return self._json(copy.to_json(), 201)

        raise ApiError(404, f"unknown endpoint: /api/projects/{pid}/{head}")


def _read_aux(project: Any, result: Any) -> str:
    """Contents of the build's .aux file, or an empty string."""
    if not result.has_pdf:
        return ""
    try:
        settings = project.load_settings()
        stem = os.path.splitext(os.path.basename(settings.get("mainFile", "main.tex")))[0]
        path = os.path.join(result.build_dir, stem + ".aux")
        if not os.path.isfile(path):
            return ""
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            return fh.read()[:400_000]
    except (OSError, AttributeError):
        return ""


def _rasterise_first_page(project: Any, pdf_path: str, query: dict[str, str]) -> bytes | None:
    """Render page 1 of a PDF/EPS to PNG so figures can preview in the editor."""
    if not TOOLCHAIN.pdftoppm:
        return None
    import subprocess
    import tempfile

    dpi = max(36, min(300, int(query.get("dpi") or 96)))
    cache_dir = os.path.join(project.meta_dir, "preview")
    os.makedirs(cache_dir, exist_ok=True)
    # Cache key: file identity + modification time + resolution.
    digest = hashlib.sha1(pdf_path.encode("utf-8")).hexdigest()[:12]
    stamp = str(int(os.path.getmtime(pdf_path)))
    cache_path = os.path.join(cache_dir, f"{digest}-{stamp}-{dpi}.png")
    if os.path.isfile(cache_path):
        with open(cache_path, "rb") as fh:
            return fh.read()
    with tempfile.TemporaryDirectory(prefix="atex-fig-") as tmp:
        try:
            subprocess.run(
                [TOOLCHAIN.pdftoppm, "-png", "-r", str(dpi), "-f", "1", "-l", "1", "-singlefile", pdf_path,
                 os.path.join(tmp, "page")],
                capture_output=True,
                timeout=60,
                stdin=subprocess.DEVNULL,
            )
        except (OSError, subprocess.SubprocessError):
            return None
        produced = os.path.join(tmp, "page.png")
        if not os.path.isfile(produced):
            return None
        with open(produced, "rb") as fh:
            data = fh.read()
    try:
        with open(cache_path, "wb") as fh:
            fh.write(data)
    except OSError:
        pass
    return data


def _json_default(value: Any) -> Any:
    if isinstance(value, (set, tuple)):
        return list(value)
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return str(value)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def find_free_port(host: str, preferred: int) -> int:
    for port in [preferred, *range(preferred + 1, preferred + 20)]:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind((host, port))
                return port
            except OSError:
                continue
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        return sock.getsockname()[1]


def banner(host: str, port: int, store: ProjectStore, toolchain_json: dict[str, Any]) -> str:
    engines = [e["label"] for e in toolchain_json["engines"] if e["available"]]
    url = f"http://{'localhost' if host in ('127.0.0.1', '0.0.0.0') else host}:{port}/"
    lines = [
        "",
        "  \033[1mATexVisualEditor\033[0m  —  LaTeX, edited visually, on every platform",
        "",
        f"  \033[36m{url}\033[0m",
        "",
        f"  Projects   {store.root}",
        f"  Engines    {', '.join(engines) if engines else 'none found — install TeX Live/MiKTeX/MacTeX'}",
        f"  Preview    {'SVG (vector)' if toolchain_json['svgPreview'] else 'PNG'}",
        f"  SyncTeX    {'yes' if toolchain_json['synctex'] else 'no'}",
        "",
        "  Press Ctrl+C to stop.",
        "",
    ]
    if not engines:
        lines.insert(
            5,
            "  \033[33mWARNING: no LaTeX engine found. The visual editor still works,\n"
            "  but the PDF preview and compilation are disabled.\033[0m",
        )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    global APP
    parser = argparse.ArgumentParser(
        prog="atex",
        description="ATexVisualEditor — a cross-platform visual LaTeX editor",
    )
    parser.add_argument("--host", default="127.0.0.1", help="interface to bind (use 0.0.0.0 for LAN access)")
    parser.add_argument("--port", type=int, default=2718, help="port to listen on (default 2718)")
    parser.add_argument("--projects", default=os.path.join(ROOT, "projects"), help="projects directory")
    parser.add_argument("--open", action="store_true", help="open the editor in a browser")
    parser.add_argument("--no-sample", action="store_true", help="do not create the demo project on first run")
    parser.add_argument("--check", action="store_true", help="report the toolchain and exit")
    args = parser.parse_args(argv)

    toolchain_json = TOOLCHAIN.to_json()
    if args.check:
        print(json.dumps(toolchain_json, indent=2))
        return 0 if toolchain_json["hasTex"] else 1

    store = ProjectStore(args.projects)
    if not args.no_sample:
        try:
            store.ensure_sample()
        except Exception as exc:  # noqa: BLE001
            print(f"could not create the demo project: {exc}")

    APP = App(args.projects)
    port = find_free_port(args.host, args.port)
    httpd = ThreadingHTTPServer((args.host, port), Handler)
    httpd.daemon_threads = True
    httpd.allow_reuse_address = True

    print(banner(args.host, port, store, toolchain_json))
    if args.open:
        url = f"http://localhost:{port}/"
        threading.Timer(0.7, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  stopping…")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
