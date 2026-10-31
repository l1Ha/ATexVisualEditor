# ATexVisualEditor

A cross-platform, visual LaTeX editor — an Overleaf-style **Visual Editor** mode
you can run entirely on your own machine, offline.

You edit a rich-text view of your document (headings, bold/italic, math, tables,
figures, citations) and the LaTeX source stays in sync in both directions.
Switch to the **Source** tab at any time; the exact TeX you expect is there,
byte for byte, including your comments and formatting quirks.

```
┌────────────────────────────────────────────────────────────────────┐
│  ATexVisualEditor        [Visual | Source]     [▶ Compile]  status │
├──────────┬─────────────────────────────┬───────────────────────────┤
│ Files    │                             │                           │
│ Outline  │   Visual editor             │   PDF preview             │
│ Problems │   (rich text, live math,    │   (vector SVG pages,      │
│ Cite     │    editable tables, chips)  │    click-to-sync both     │
│          │                             │    ways via SyncTeX)      │
│          │   Source editor (with       │   Build log / problems    │
│          │    syntax highlighting)     │                           │
└──────────┴─────────────────────────────┴───────────────────────────┘
```

## Quick start

Requirements: **Python 3.9+** (standard library only — no `pip install` needed)
and, for compilation and PDF preview, **any TeX distribution** (TeX Live,
MiKTeX or MacTeX). Editing, project management and the source view work
without TeX.

```bash
python3 atex.py              # start the editor and print the URL
```

- **Windows:** double-click `start.bat`, or run `python atex.py`
- **macOS / Linux:** `./start.sh`, or run `python3 atex.py`

Then open <http://localhost:2718>. A demo project
(“Welcome to ATexVisualEditor”) is created on first run and exercises every
feature: math, tables, figures, citations, footnotes, labels and links.

Useful flags:

```bash
python3 atex.py --port 3000          # pick a port
python3 atex.py --host 0.0.0.0       # open it to the LAN — edit from a tablet
python3 atex.py --open               # also launch your browser
python3 atex.py --no-sample          # do not create the demo project
python3 atex.py --check              # report which TeX tools were found
```

The first run of each document compiles a few times (LaTeX needs passes for
labels and the table of contents); the toolbar “Compile” button and
`Ctrl+Enter` rebuild at any point, and the editor also recompiles shortly
after you stop typing.

## What works

**Visual editing** (Overleaf Visual Editor style)

- Paragraphs, headings (`\section`…`\subsubsection`), bold/italic/underline/
  strikethrough/code, inline and display math with live rendering, itemize /
  enumerate / description lists with Tab indentation, block quotes
- Tables with a real grid: edit cells, add/remove rows and columns, change
  alignment, `\toprule`/`\midrule`/`\bottomrule` preserved — including tables
  inside `\begin{table}` floats and `tabularray`-style `tblr` environments
- Figures: drag-and-drop or paste images, resize, edit captions and labels
- Citations (natbib/biblatex) and `\ref`/`\eqref` render as chips showing the
  *resolved* number once the project has been compiled
- Footnotes, `\label`, hyperlinks, verbatim, and a preamble card for
  everything before `\begin{document}`
- Everything the visual editor does not model (custom macros, exotic
  environments, comments) is displayed safely and written back **unchanged**

**Source editing**

- Syntax-highlighted editor with gutter, auto-indent on Enter, bracket and
  environment wrapping, `Ctrl+/` comment toggle, line duplication
- Two-way sync: edits in either view appear in the other immediately

**Compilation & preview**

- `latexmk` when available (automatic multi-pass), otherwise a manual
  `pdflatex`/`xelatex`/`lualatex` loop with re-run detection
- Vector SVG page preview (falls back to PNG), zoom and fit-width
- **SyncTeX both ways**: Ctrl+click in the PDF jumps to the source line;
  Ctrl+click in the visual editor highlights the PDF location
- Diagnostics panel: errors, warnings and bad boxes with clickable line
  numbers; the `.aux` file is parsed so references and citations resolve in
  the visual view
- `shell-escape` is **off** unless a project explicitly opts in

**Projects**

- Projects are plain folders under `projects/` — your files stay yours
- Create from templates (article, report, beamer, letter, multilingual,
  blank), import/export ZIP archives, duplicate, delete
- Upload images, create/rename files and folders, multi-file `\input`/
  `\include` projects with a configurable main file — the visual editor shows
  included files as chips you can click to open
- Bibliography panel over `.bib` files with formatted previews

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| `Ctrl+Enter` | Compile |
| `Ctrl+S` | Save the active file |
| `Ctrl+B` / `Ctrl+I` | Bold / italic (visual mode) |
| `Ctrl+F` / `Ctrl+H` | Find / find-and-replace (source mode) |
| `Ctrl+K` | Command palette |
| `Ctrl+Shift+1…4` | Part / section / subsection / subsubsection |
| `Ctrl+M` | Toggle visual / source / split focus |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo (coalesced, works across views) |

## Layout of this repository

```
atex.py                  launcher (also start.sh / start.bat)
server/                  Python standard-library backend
  app.py                 HTTP server + REST API
  projects.py            project store (traversal-safe paths, ZIP import/export)
  compiler.py            toolchain detection, builds, SVG pages, SyncTeX
  templates.py           document templates
web/                     the whole front end — plain ES modules, no build step
  js/core/               LaTeX CST: parser, printer, document model, .bib parser
  js/visual/             block model, DOM rendering, reconciliation, editor
  js/source/             source editor + highlighter
  js/pdf/                PDF page viewer
  vendor/katex/          vendored KaTeX (works fully offline)
tests/
  jsrunner.py            headless QuickJS runner for the browser modules
  core.test.js           31 round-trip / editing tests of the LaTeX core
  test_server.py         end-to-end tests of the HTTP API (no browser needed)
docs/ARCHITECTURE.md     how the editor works internally
```

## Tests

The LaTeX core (parse → edit → print) is tested headlessly; the HTTP API is
tested end-to-end with Python's own `unittest`:

```bash
python3 tests/jsrunner.py        # LaTeX core: needs `pip3 install quickjs`
python3 tests/test_server.py     # REST API: stdlib only
```

## Troubleshooting

- **“no LaTeX engine found”** — install TeX Live (`sudo apt install texlive-full`
  is the easiest full option; `texlive-latex-extra` plus `latexmk` is enough for
  the demo), MiKTeX (Windows) or MacTeX (macOS). Run `python3 atex.py --check`
  to see what was detected. The server picks up new installations on restart.
- **Preview shows PNG instead of vector pages** — `pdftocairo` (poppler-utils)
  is missing; install it for sharper previews.
- **References show as “?”** — compile once; numbers come from the `.aux`
  file of the latest build.
- **Port already in use** — the server automatically tries the next 20 ports;
  the real URL is printed at startup.
- **A document compiles on the command line but not here** — check the Problems
  panel; multi-file projects may need the main file set in project settings
  (gear icon in the Files panel).

## Security notes

The server binds to `127.0.0.1` by default and is meant for local use. Project
paths are guarded against directory traversal, uploads are size-limited, and
LaTeX compilation runs with `shell-escape` disabled unless you enable it for a
specific project — treat a project you enable it for as trusted code.
