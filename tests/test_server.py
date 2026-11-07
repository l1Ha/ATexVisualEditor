#!/usr/bin/env python3
"""
End-to-end tests for ATexVisualEditor's HTTP API.

Boots the real server (`server/app.py`) on a throwaway projects directory and
exercises the REST surface the way the browser front end does — with plain
HTTP.  No browser and no third-party packages are needed.

    python3 tests/test_server.py            # quiet
    python3 tests/test_server.py -v         # per-test output

Tests that need a TeX distribution (compile, PDF pages, math preview) are
skipped automatically when none is installed.
"""

from __future__ import annotations

import io
import json
import os
import shutil
import socket
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from server import app as server_app  # noqa: E402
from server.compiler import TOOLCHAIN  # noqa: E402

HOST = "127.0.0.1"

SIMPLE_DOC = r"""\documentclass{article}
\begin{document}
Hello, \textbf{world}!
\section{Intro}\label{sec:intro}
See Section~\ref{sec:intro}.
\end{document}
"""


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((HOST, 0))
        return sock.getsockname()[1]


class ServerFixture:
    """Start the real HTTP server against a temporary projects directory."""

    def __init__(self) -> None:
        self.projects_dir = tempfile.mkdtemp(prefix="atex-test-")
        self.port = free_port()
        server_app.APP = server_app.App(self.projects_dir)
        self.httpd = server_app.ThreadingHTTPServer((HOST, self.port), server_app.Handler)
        self.httpd.daemon_threads = True
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def stop(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)
        server_app.APP = None
        shutil.rmtree(self.projects_dir, ignore_errors=True)

    # -- HTTP helpers ---------------------------------------------------------

    def url(self, path: str) -> str:
        return f"http://{HOST}:{self.port}{path}"

    def request(self, method: str, path: str, *, data=None, json_body=None, raw: bytes | None = None):
        body = raw
        headers = {}
        if json_body is not None:
            body = json.dumps(json_body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        elif isinstance(data, str):
            body = data.encode("utf-8")
        req = urllib.request.Request(self.url(path), data=body, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.status, resp.read(), resp.headers
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read(), exc.headers

    def json_request(self, method: str, path: str, *, json_body=None):
        status, raw, _ = self.request(method, path, json_body=json_body)
        payload = json.loads(raw.decode("utf-8")) if raw else None
        return status, payload


class ServerTests(unittest.TestCase):
    server: ServerFixture

    @classmethod
    def setUpClass(cls) -> None:
        cls.server = ServerFixture()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.stop()

    # -- basics ---------------------------------------------------------------

    def test_status_and_index(self):
        status, payload = self.server.json_request("GET", "/api/status")
        self.assertEqual(status, 200)
        self.assertIn("version", payload)
        self.assertIn("toolchain", payload)
        self.assertTrue(payload["projectsDir"].startswith(tempfile.gettempdir()))

        status, raw, headers = self.server.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"ATexVisualEditor", raw)
        self.assertIn("text/html", headers["Content-Type"])

    def test_spa_fallback_and_missing_assets(self):
        status, raw, _ = self.server.request("GET", "/some/client/route")
        self.assertEqual(status, 200)  # SPA fallback serves the shell
        status, _, _ = self.server.request("GET", "/js/does-not-exist.js")
        self.assertEqual(status, 404)

    def test_unknown_api_endpoint(self):
        status, payload = self.server.json_request("GET", "/api/definitely-not-a-thing")
        self.assertEqual(status, 404)
        self.assertIn("error", payload)

    # -- project lifecycle ------------------------------------------------------

    def test_project_lifecycle(self):
        server = self.server

        # create with explicit content
        status, project = server.json_request(
            "POST", "/api/projects", json_body={"name": "Integration Test", "content": SIMPLE_DOC}
        )
        self.assertEqual(status, 201)
        pid = project["id"]
        self.assertTrue(pid)

        # listed
        status, listing = server.json_request("GET", "/api/projects")
        self.assertEqual(status, 200)
        self.assertIn(pid, [p["id"] for p in listing["projects"]])

        # tree + detected main file
        status, tree = server.json_request("GET", f"/api/projects/{pid}/tree")
        self.assertEqual(status, 200)
        self.assertEqual(tree["mainFile"], "main.tex")

        # file write / read round trip
        status, _ = server.json_request(
            "PUT", f"/api/projects/{pid}/file?path=notes/todo.txt", json_body={"content": "buy milk\n"}
        )
        self.assertEqual(status, 200)
        status, payload = server.json_request("GET", f"/api/projects/{pid}/file?path=notes/todo.txt")
        self.assertEqual(status, 200)
        self.assertEqual(payload["content"], "buy milk\n")

        # mkdir + rename
        status, _ = server.json_request("POST", f"/api/projects/{pid}/mkdir", json_body={"path": "figures"})
        self.assertEqual(status, 200)
        status, _ = server.json_request(
            "POST", f"/api/projects/{pid}/rename", json_body={"from": "notes/todo.txt", "to": "notes/list.md"}
        )
        self.assertEqual(status, 200)
        status, payload = server.json_request("GET", f"/api/projects/{pid}/file?path=notes/list.md")
        self.assertEqual(status, 200)

        # settings update
        status, payload = server.json_request("PUT", f"/api/projects/{pid}", json_body={"mainFile": "main.tex"})
        self.assertEqual(status, 200)
        self.assertEqual(payload["settings"]["mainFile"], "main.tex")

        # upload a small binary
        png = bytes.fromhex(
            "89504e470d0a1a0a0000000d494844520000000100000001080200000090"
            "7753de0000000c4944415408d763f8cfc00000030101"
            "00c9fe92ef0000000049454e44ae426082"
        )
        status, _, _ = server.request("POST", f"/api/projects/{pid}/upload?path=figures/dot.png", raw=png)
        self.assertEqual(status, 200)
        status, raw, headers = server.request("GET", f"/api/projects/{pid}/raw?path=figures/dot.png")
        self.assertEqual(status, 200)
        self.assertEqual(raw, png)

        # delete a file, then the project
        status, _ = server.json_request("DELETE", f"/api/projects/{pid}/file?path=notes/list.md")
        self.assertEqual(status, 200)
        status, _ = server.json_request("DELETE", f"/api/projects/{pid}")
        self.assertEqual(status, 200)
        status, _ = server.json_request("GET", f"/api/projects/{pid}/tree")
        self.assertEqual(status, 404)

    def test_path_traversal_is_refused(self):
        status, project = self.server.json_request(
            "POST", "/api/projects", json_body={"name": "Guard Test", "content": SIMPLE_DOC}
        )
        pid = project["id"]
        for bad in ["../evil.tex", "..\\evil.tex", "/etc/passwd", ".atex/project.json", "a/../..//x.tex"]:
            status, _ = self.server.json_request(
                "PUT", f"/api/projects/{pid}/file?path={urllib.parse.quote(bad)}",
                json_body={"content": "nope"},
            )
            self.assertEqual(status, 404, bad)  # ProjectError → 404, never a write
        status, raw, _ = self.server.request("GET", "/api/projects/..%2f..%2fsecret/file")
        self.assertEqual(status, 404)
        self.server.json_request("DELETE", f"/api/projects/{pid}")

    def test_invalid_project_ids(self):
        for pid in ["", "%2e%2e", "a$b", "x" * 100]:
            status, _ = self.server.json_request("GET", f"/api/projects/{urllib.parse.quote(pid)}/tree")
            self.assertEqual(status, 404)

    # -- zip import / export / duplicate ---------------------------------------

    def test_zip_import_export_duplicate(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as zf:
            zf.writestr("my-paper/main.tex", SIMPLE_DOC)
            zf.writestr("my-paper/refs.bib", "@book{k1, title={T}, author={A}, year={2024}}\n")
            zf.writestr("my-paper/__MACOSX/junk", "skipped")
        status, raw, _ = self.server.request("POST", "/api/projects/import?name=Imported", raw=buffer.getvalue())
        self.assertEqual(status, 201)
        project = json.loads(raw.decode("utf-8"))
        pid = project["id"]

        status, tree = self.server.json_request("GET", f"/api/projects/{pid}/tree")
        paths = {f["path"] for f in tree["files"]}
        self.assertIn("main.tex", paths)  # single top-level folder is flattened
        self.assertIn("refs.bib", paths)
        self.assertFalse(any("__MACOSX" in p for p in paths))

        status, raw, headers = self.server.request("GET", f"/api/projects/{pid}/export")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "application/zip")
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            self.assertIn("main.tex", zf.namelist())

        status, copy = self.server.json_request("POST", f"/api/projects/{pid}/duplicate")
        self.assertEqual(status, 201)
        self.assertNotEqual(copy["id"], pid)
        status, tree = self.server.json_request("GET", f"/api/projects/{copy['id']}/tree")
        self.assertIn("main.tex", {f["path"] for f in tree["files"]})

        for other in (pid, copy["id"]):
            self.server.json_request("DELETE", f"/api/projects/{other}")

    # -- compilation, pages, synctex, math (need TeX) ---------------------------

    def _make_doc(self, name: str) -> str:
        status, project = self.server.json_request(
            "POST", "/api/projects", json_body={"name": name, "content": SIMPLE_DOC}
        )
        self.assertEqual(status, 201)
        return project["id"]

    @unittest.skipUnless(
        TOOLCHAIN.to_json()["hasTex"] and TOOLCHAIN.pdfinfo,
        "TeX or pdfinfo (poppler) not installed",
    )
    def test_compile_and_pages(self):
        pid = self._make_doc("compile-test")
        status, result = self.server.json_request("POST", f"/api/projects/{pid}/compile", json_body={})
        self.assertEqual(status, 200)
        self.assertTrue(result["ok"], result.get("log", "")[-400:])
        self.assertGreaterEqual(result["pages"], 1)
        self.assertIn("\\newlabel", result["aux"])  # aux parsed for reference chips

        status, raw, headers = self.server.request("GET", result["pdfUrl"])
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "application/pdf")
        self.assertTrue(raw.startswith(b"%PDF"))

        status, raw, headers = self.server.request("GET", f"/api/projects/{pid}/page/1.svg")
        self.assertEqual(status, 200)
        self.assertIn(headers["Content-Type"], ("image/svg+xml", "image/png"))

        status, payload = self.server.json_request("GET", f"/api/projects/{pid}/builds")
        self.assertEqual(status, 200)
        self.assertTrue(payload["builds"])

        self.server.json_request("DELETE", f"/api/projects/{pid}")

    @unittest.skipUnless(
        TOOLCHAIN.to_json()["hasTex"] and TOOLCHAIN.synctex,
        "TeX or synctex not installed",
    )
    def test_synctex_round_trip(self):
        pid = self._make_doc("synctex-test")
        status, result = self.server.json_request("POST", f"/api/projects/{pid}/compile", json_body={})
        self.assertEqual(status, 200)
        self.assertTrue(result["ok"])

        status, payload = self.server.json_request(
            "POST",
            f"/api/projects/{pid}/synctex",
            json_body={"direction": "forward", "file": "main.tex", "line": 3},
        )
        self.assertEqual(status, 200)
        hits = payload["hits"]
        self.assertTrue(hits, "expected a forward-sync hit for line 3")
        page = hits[0]["page"]

        status, payload = self.server.json_request(
            "POST",
            f"/api/projects/{pid}/synctex",
            json_body={"direction": "inverse", "page": page, "x": hits[0]["x"], "y": hits[0]["y"]},
        )
        self.assertEqual(status, 200)
        self.assertTrue(payload["hit"])
        self.assertEqual(payload["hit"]["line"], 3)

        self.server.json_request("DELETE", f"/api/projects/{pid}")

    @unittest.skipUnless(
        TOOLCHAIN.to_json()["hasTex"] and TOOLCHAIN.dvisvgm,
        "TeX or dvisvgm not installed",
    )
    def test_math_svg(self):
        status, payload = self.server.json_request(
            "POST", "/api/math/svg", json_body={"latex": "e^{i\\pi} + 1 = 0", "display": True}
        )
        self.assertEqual(status, 200)
        svg = payload["svg"]
        self.assertIsNotNone(svg)
        self.assertIn("<svg", svg)
        self.assertTrue(payload["cached"] is False or payload["cached"] is True)
        # second identical request hits the cache
        status, again = self.server.json_request(
            "POST", "/api/math/svg", json_body={"latex": "e^{i\\pi} + 1 = 0", "display": True}
        )
        self.assertEqual(again["svg"], svg)


if __name__ == "__main__":
    unittest.main(verbosity=2 if "-v" in sys.argv else 1)
