"""
ATexVisualEditor — project storage.

A "project" is just a directory on disk: the user's .tex/.bib/.png files, plus a
`.atex/` metadata folder (settings, build artifacts).  Keeping projects as
plain directories means they can be opened, edited, version-controlled and
zipped with ordinary tools — nothing is locked inside an application database.

All path handling goes through `Project.safe_path`, which refuses anything that
would escape the project directory.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import struct
import time
import zipfile
import zlib
from dataclasses import dataclass
from io import BytesIO
from typing import Any, Iterable

META_DIR = ".atex"
MANIFEST = "project.json"
MAX_UPLOAD = 64 * 1024 * 1024

TEXT_EXTENSIONS = {
    ".tex", ".ltx", ".latex", ".bib", ".cls", ".sty", ".def", ".cfg", ".bst",
    ".txt", ".md", ".markdown", ".json", ".yaml", ".yml", ".csv", ".tsv",
    ".tikz", ".pgf", ".py", ".lua", ".sh", ".toml", ".ini", ".xml", ".html",
    ".css", ".js", ".asy", ".mp", ".Rnw", ".rmd",
}

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".pdf", ".eps", ".ps"}

LATEX_EXTENSIONS = {".tex", ".ltx", ".latex"}


class ProjectError(Exception):
    """Bad request against a project (missing file, illegal path, ...)."""


def is_text_file(path: str) -> bool:
    ext = os.path.splitext(path)[1].lower()
    if ext in TEXT_EXTENSIONS:
        return True
    if ext in IMAGE_EXTENSIONS:
        return False
    return False


def slugify(name: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", (name or "").strip().lower()).strip("-.")
    slug = re.sub(r"-{2,}", "-", slug)
    return slug or "project"


@dataclass
class Project:
    store: "ProjectStore"
    id: str
    dir: str

    # -- metadata ------------------------------------------------------------

    @property
    def meta_dir(self) -> str:
        return os.path.join(self.dir, META_DIR)

    @property
    def manifest_path(self) -> str:
        return os.path.join(self.meta_dir, MANIFEST)

    def load_settings(self) -> dict[str, Any]:
        defaults = {
            "name": self.id,
            "mainFile": "",
            "engine": "",
            "autoCompile": True,
            "compileDelayMs": 900,
            "shellEscape": False,
            "timeout": 180,
            "createdAt": 0,
            "updatedAt": 0,
            "spellCheck": True,
            "fontSize": 15,
        }
        try:
            with open(self.manifest_path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, dict):
                defaults.update(data)
        except (OSError, ValueError):
            pass
        if not defaults.get("mainFile"):
            defaults["mainFile"] = self.detect_main_file()
        return defaults

    def save_settings(self, updates: dict[str, Any]) -> dict[str, Any]:
        settings = self.load_settings()
        allowed = {
            "name", "mainFile", "engine", "autoCompile", "compileDelayMs",
            "shellEscape", "timeout", "spellCheck", "fontSize",
        }
        for key, value in (updates or {}).items():
            if key in allowed:
                settings[key] = value
        settings["updatedAt"] = time.time()
        if not settings.get("createdAt"):
            settings["createdAt"] = time.time()
        os.makedirs(self.meta_dir, exist_ok=True)
        tmp = self.manifest_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(settings, fh, indent=2, sort_keys=True)
        os.replace(tmp, self.manifest_path)
        return settings

    def touch(self) -> None:
        settings = self.load_settings()
        settings["updatedAt"] = time.time()
        settings.setdefault("createdAt", time.time())
        os.makedirs(self.meta_dir, exist_ok=True)
        try:
            with open(self.manifest_path, "w", encoding="utf-8") as fh:
                json.dump(settings, fh, indent=2, sort_keys=True)
        except OSError:
            pass

    # -- paths ---------------------------------------------------------------

    def safe_path(self, rel: str, *, allow_meta: bool = False) -> str:
        """Resolve a project-relative path, refusing anything outside the project."""
        if rel is None:
            raise ProjectError("missing path")
        rel = str(rel).replace("\\", "/").strip()
        if not rel:
            raise ProjectError("empty path")
        if "\x00" in rel:
            raise ProjectError("illegal path")
        if rel.startswith("/") or re.match(r"^[A-Za-z]:", rel):
            raise ProjectError("absolute paths are not allowed")
        parts = [p for p in rel.split("/") if p not in ("", ".")]
        if any(p == ".." for p in parts):
            raise ProjectError("path may not leave the project")
        if not allow_meta and parts and parts[0] == META_DIR:
            raise ProjectError("the .atex folder is reserved")
        resolved = os.path.abspath(os.path.join(self.dir, *parts))
        root = os.path.abspath(self.dir)
        if resolved != root and not resolved.startswith(root + os.sep):
            raise ProjectError("path may not leave the project")
        return resolved

    # -- reading / writing ---------------------------------------------------

    def read_bytes(self, rel: str) -> bytes:
        path = self.safe_path(rel)
        if not os.path.isfile(path):
            raise ProjectError(f"no such file: {rel}")
        with open(path, "rb") as fh:
            return fh.read()

    def write_bytes(self, rel: str, data: bytes) -> int:
        path = self.safe_path(rel)
        if os.path.isdir(path):
            raise ProjectError(f"“{rel}” is a folder, not a file")
        os.makedirs(os.path.dirname(path) or self.dir, exist_ok=True)
        tmp = path + ".atex-tmp"
        with open(tmp, "wb") as fh:
            fh.write(data)
        os.replace(tmp, path)
        self.touch()
        return len(data)

    def read_text(self, rel: str) -> str:
        data = self.read_bytes(rel)
        return data.decode("utf-8", errors="replace")

    def write_text(self, rel: str, content: str) -> int:
        return self.write_bytes(rel, content.encode("utf-8"))

    def exists(self, rel: str) -> bool:
        try:
            return os.path.isfile(self.safe_path(rel))
        except ProjectError:
            return False

    def delete(self, rel: str) -> None:
        path = self.safe_path(rel)
        if os.path.isdir(path):
            shutil.rmtree(path)
        elif os.path.isfile(path):
            os.remove(path)
        else:
            raise ProjectError(f"no such file: {rel}")
        self.touch()

    def rename(self, old: str, new: str) -> None:
        src = self.safe_path(old)
        dst = self.safe_path(new)
        if not os.path.exists(src):
            raise ProjectError(f"no such file: {old}")
        os.makedirs(os.path.dirname(dst) or self.dir, exist_ok=True)
        if os.path.exists(dst):
            raise ProjectError(f"“{new}” already exists")
        os.rename(src, dst)
        self.touch()

    def mkdir(self, rel: str) -> None:
        path = self.safe_path(rel)
        os.makedirs(path, exist_ok=True)
        self.touch()

    # -- listing -------------------------------------------------------------

    def tree(self) -> list[dict[str, Any]]:
        entries: list[dict[str, Any]] = []

        def walk(rel_dir: str) -> None:
            abs_dir = os.path.join(self.dir, rel_dir) if rel_dir else self.dir
            try:
                names = sorted(os.listdir(abs_dir))
            except OSError:
                return
            for name in names:
                if name == META_DIR or name.endswith(".atex-tmp"):
                    continue
                rel = f"{rel_dir}/{name}" if rel_dir else name
                abs_path = os.path.join(abs_dir, name)
                try:
                    stat = os.stat(abs_path)
                except OSError:
                    continue
                if os.path.isdir(abs_path):
                    entries.append({"path": rel, "name": name, "type": "dir", "mtime": stat.st_mtime})
                    walk(rel)
                else:
                    entries.append(
                        {
                            "path": rel,
                            "name": name,
                            "type": "file",
                            "size": stat.st_size,
                            "mtime": stat.st_mtime,
                            "text": is_text_file(name),
                            "latex": os.path.splitext(name)[1].lower() in LATEX_EXTENSIONS,
                            "image": os.path.splitext(name)[1].lower() in IMAGE_EXTENSIONS,
                        }
                    )

        walk("")
        return entries

    def file_count(self) -> int:
        return sum(1 for e in self.tree() if e["type"] == "file")

    def tex_files(self) -> list[str]:
        return [e["path"] for e in self.tree() if e["type"] == "file" and e["latex"]]

    def bib_files(self) -> list[str]:
        return [e["path"] for e in self.tree() if e["type"] == "file" and e["name"].lower().endswith(".bib")]

    # -- main-file detection -------------------------------------------------

    def detect_main_file(self) -> str:
        """Pick the document that actually builds: it has \\documentclass."""
        candidates: list[tuple[int, str]] = []
        for rel in self.tex_files():
            try:
                text = self.read_text(rel)
            except (ProjectError, OSError):
                continue
            score = 0
            if "\\documentclass" in text:
                score += 100
            if "\\begin{document}" in text:
                score += 50
            if rel.lower() in ("main.tex", "paper.tex", "thesis.tex", "document.tex", "master.tex"):
                score += 20
            if "/" not in rel:
                score += 5
            if score:
                candidates.append((score, rel))
        if not candidates:
            tex = self.tex_files()
            return tex[0] if tex else ""
        candidates.sort(key=lambda pair: (-pair[0], pair[1]))
        return candidates[0][1]

    def to_json(self, *, deep: bool = True) -> dict[str, Any]:
        settings = self.load_settings()
        data = {
            "id": self.id,
            "name": settings.get("name") or self.id,
            "mainFile": settings.get("mainFile"),
            "engine": settings.get("engine") or "",
            "updatedAt": settings.get("updatedAt") or 0,
        }
        if deep:
            data["settings"] = settings
            data["files"] = self.tree()
            data["buildId"] = self.last_build_id()
        return data

    def last_build_id(self) -> str | None:
        try:
            with open(os.path.join(self.meta_dir, "latest.json"), "r", encoding="utf-8") as fh:
                return json.load(fh).get("buildId")
        except (OSError, ValueError):
            return None

    # -- zip -----------------------------------------------------------------

    def zip_bytes(self) -> bytes:
        buffer = BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
            for entry in self.tree():
                if entry["type"] != "file":
                    continue
                try:
                    zf.write(self.safe_path(entry["path"]), entry["path"])
                except (OSError, ProjectError):
                    continue
        return buffer.getvalue()

    def import_zip(self, data: bytes) -> int:
        """Extract a zip into the project, flattening a single top-level folder."""
        count = 0
        with zipfile.ZipFile(BytesIO(data)) as zf:
            names = [n for n in zf.namelist() if not n.endswith("/")]
            prefix = ""
            if names:
                first = names[0].split("/")[0]
                if first and all(n.startswith(first + "/") for n in names):
                    prefix = first + "/"
            for info in zf.infolist():
                if info.is_dir():
                    continue
                name = info.filename
                if prefix and name.startswith(prefix):
                    name = name[len(prefix) :]
                name = name.replace("\\", "/").lstrip("/")
                if not name or ".." in name.split("/") or "__MACOSX" in name:
                    continue
                try:
                    target = self.safe_path(name)
                except ProjectError:
                    continue
                os.makedirs(os.path.dirname(target) or self.dir, exist_ok=True)
                with zf.open(info) as src, open(target, "wb") as dst:
                    shutil.copyfileobj(src, dst, 64 * 1024)
                count += 1
        self.touch()
        return count


# ---------------------------------------------------------------------------
# Store
# ---------------------------------------------------------------------------


class ProjectStore:
    def __init__(self, root: str) -> None:
        self.root = os.path.abspath(root)
        os.makedirs(self.root, exist_ok=True)

    def _project_dir(self, pid: str) -> str:
        return os.path.join(self.root, pid)

    def list(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for name in sorted(os.listdir(self.root)):
            if name.startswith("."):
                continue
            path = os.path.join(self.root, name)
            if not os.path.isdir(path):
                continue
            project = Project(self, name, path)
            settings = project.load_settings()
            files = project.tree()
            out.append(
                {
                    "id": name,
                    "name": settings.get("name") or name,
                    "mainFile": settings.get("mainFile"),
                    "engine": settings.get("engine") or "",
                    "updatedAt": settings.get("updatedAt") or os.path.getmtime(path),
                    "fileCount": sum(1 for f in files if f["type"] == "file"),
                    "hasPdf": bool(project.last_build_id()),
                }
            )
        out.sort(key=lambda p: -(p.get("updatedAt") or 0))
        return out

    def open(self, pid: str) -> Project:
        if not pid or not re.fullmatch(r"[A-Za-z0-9._-]{1,80}", pid):
            raise ProjectError("invalid project id")
        path = self._project_dir(pid)
        if not os.path.isdir(path):
            raise ProjectError(f"no such project: {pid}")
        return Project(self, pid, path)

    def create(self, name: str, template: str = "article", *, content: str | None = None,
               main_name: str = "main.tex") -> Project:
        base = slugify(name)
        pid = base
        counter = 2
        while os.path.exists(self._project_dir(pid)):
            pid = f"{base}-{counter}"
            counter += 1
        path = self._project_dir(pid)
        os.makedirs(path, exist_ok=True)
        project = Project(self, pid, path)
        if content is not None:
            project.write_text(main_name, content)
        else:
            from . import templates  # local import: templates are optional data
            for rel, text in templates.template_files(template, title=name).items():
                project.write_text(rel, text)
        project.save_settings(
            {
                "name": name or pid,
                "createdAt": time.time(),
                "updatedAt": time.time(),
                "mainFile": project.detect_main_file() or main_name,
            }
        )
        return project

    def duplicate(self, pid: str) -> Project:
        source = self.open(pid)
        data = source.zip_bytes()
        settings = source.load_settings()
        new = self.create(f"{settings.get('name') or pid} copy", "blank")
        new.import_zip(data)
        new.save_settings({"mainFile": settings.get("mainFile", ""), "engine": settings.get("engine", "")})
        return new

    def delete(self, pid: str) -> None:
        project = self.open(pid)
        shutil.rmtree(project.dir, ignore_errors=True)

    def ensure_sample(self) -> Project:
        """
        Create the demo project on first run so the app is never empty.

        Guarded on the *slugified* name, because that is what `create` will
        actually use for the directory — checking a different string used to
        create a fresh "welcome-...-2" project on every start.
        """
        pid = slugify("Welcome to ATexVisualEditor")
        if os.path.isdir(self._project_dir(pid)):
            return self.open(pid)
        from . import templates

        project = self.create("Welcome to ATexVisualEditor", "blank", main_name="main.tex")
        for rel, text in templates.template_files("welcome", title="Welcome to ATexVisualEditor").items():
            project.write_text(rel, text)
        png = make_demo_plot_png()
        project.write_bytes("figures/plot.png", png)
        project.save_settings({"mainFile": "main.tex", "name": "Welcome to ATexVisualEditor"})
        return project


# ---------------------------------------------------------------------------
# A tiny PNG writer, so the demo project can ship a real figure without any
# image library being installed.
# ---------------------------------------------------------------------------


def _png(width: int, height: int, rows: Iterable[bytes]) -> bytes:
    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    raw = b"".join(b"\x00" + row for row in rows)
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def make_demo_plot_png(width: int = 640, height: int = 400) -> bytes:
    """A clean, readable line-and-bar chart drawn by hand at the pixel level."""
    bg = (255, 255, 255)
    grid = (226, 232, 240)
    axis = (100, 116, 139)
    accent = (37, 99, 235)
    accent2 = (219, 39, 119)
    gridline_rows = {height - 40 - int(i * (height - 100) / 5) for i in range(6)}
    gridline_cols = {60 + int(i * (width - 100) / 8) for i in range(9)}

    def plot_point(i: int) -> tuple[int, int]:
        xs = [0, 1, 2, 3, 4, 5, 6, 7, 8]
        ys = [1.2, 1.9, 1.6, 2.6, 3.1, 2.7, 3.6, 4.1, 4.6]
        x = 60 + int(i * (width - 100) / 8)
        y = height - 40 - int((ys[i] / 5.0) * (height - 100))
        return x, y

    points = [plot_point(i) for i in range(9)]
    canvas = [[bg for _ in range(width)] for _ in range(height)]
    # grid
    for y in range(height):
        for x in range(width):
            if y in gridline_rows or x in gridline_cols:
                canvas[y][x] = grid
    # axes
    for x in range(50, width - 20):
        canvas[height - 40][x] = axis
    for y in range(30, height - 30):
        canvas[y][60] = axis
    # bars behind the line
    for idx, (x, y) in enumerate(points):
        bar_top = height - 40 - int((idx + 1) * 10)
        for yy in range(max(bar_top, y + 6), height - 40):
            for xx in range(x + 3, min(x + 20, width)):
                canvas[yy][xx] = (219, 234, 254)
    # line (with a simple thickness)
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        steps = max(abs(x1 - x0), abs(y1 - y0), 1)
        for s in range(steps + 1):
            px = x0 + (x1 - x0) * s // steps
            py = y0 + (y1 - y0) * s // steps
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if 0 <= py + dy < height and 0 <= px + dx < width:
                        canvas[py + dy][px + dx] = accent
    # markers
    for (x, y) in points:
        for dy in range(-4, 5):
            for dx in range(-4, 5):
                if dx * dx + dy * dy <= 16 and 0 <= y + dy < height and 0 <= x + dx < width:
                    canvas[y + dy][x + dx] = accent2

    rows = [bytes(v for pixel in row for v in pixel) for row in canvas]
    return _png(width, height, rows)
