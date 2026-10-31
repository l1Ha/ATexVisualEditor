# ATexVisualEditor — architecture

This note explains how the editor keeps a rich-text view and a LaTeX source
in sync without ever losing information. Read the README first for usage.

The whole system is built around one idea:

> **The source string is the single source of truth.** Every render is a
> projection of it; every edit is a new version of it.

```
            parse()                render
  source ───────────▶ CST ───────────────▶ DOM (visual view)
     ▲                 │  \──▶ outline, labels, citations, …
     │   print()       │
     └─────────────────┘
        (byte-identical when nothing changed)
```

## 1. The CST: a lossless concrete syntax tree

`web/js/core/ast.js`, `parser.js`, `printer.js`

Most LaTeX tooling parses into an abstract tree and throws formatting away.
We cannot afford that: the user must be able to round-trip their file through
the visual editor and get the *same bytes* back. So the parser builds a
**concrete** syntax tree where every node covers an exact `[start, end)` span
of the source and caches its raw text:

- **text** — plain characters, including whitespace and line breaks
- **comment** — `% …` to end of line (preserved verbatim, shown as a muted
  block in the visual view)
- **command** — `\name`, optionally starred, with a list of argument nodes
- **environment** — `\begin{name}…\end{name}` with child nodes
- **group** — `{…}`, **argument** — one argument with leading-whitespace data
- **math** — `$…$`, `$$…$$`, `\[…\]` and math environments
- **raw** — anything the parser wants to guarantee it never rewrites

Two invariants are enforced after every parse (`verifyTiling` in
`parser.js`, also asserted by the test suite):

1. **tiling** — the children of every list join with no gaps and no overlaps:
   `child[i].end === child[i+1].start`, and the root's children tile the
   whole document.
2. **reprint equality** — printing a *clean* (unedited) tree reproduces the
   source byte for byte.

The printer walks the tree: clean nodes emit their cached `raw` (and refresh
their spans as a side effect), dirty nodes re-serialize from their children.
Structural edits therefore only pay for what changed.

`latex-knowledge.js` is the small database that tells the renderer what
commands and environments *mean* — which produce inline formatting, which are
invisible, which are sections, lists, tables (`tabular`) vs. table floats
(`table`), where arguments sit, and how to escape special characters. It is
data, not code, so supporting a new package is a table edit.

## 2. Blocks: projecting the tree onto a page

`web/js/visual/blocks.js`

The DOM is contenteditable, but LaTeX is not a flat character stream, so
rendering is organised as **blocks**: paragraph, heading, list, list-item,
math display, table, figure, quote, code, verbatim, raw, comment, preamble…

`buildBlocks(nodes, list)` walks the top-level tree (and lifted bodies of
`document`/float environments) and returns a plan:

```js
plan = [{ type: BlockType.Paragraph, node, visible, after }, …]
```

`after` carries the whitespace/comments that sat between two paragraphs so
nothing is lost when the plan is written back. Anything not recognised
becomes a `Raw` block shown as a read-only card — displayed safely, never
mangled. Everything before `\begin{document}` collapses into a single
**Preamble** block.

## 3. Rendering and reconciliation

`web/js/visual/render.js`, `reconcile.js`

`render` builds the DOM for the block plan: paragraphs from runs of inline
nodes (with `trimEdge` making sure edge whitespace like the space after a
`\label` is *not* eaten), chips for citations/refs/labels/footnotes, KaTeX
for math (`sanitizeMathForDisplay` strips `\label` and friends that KaTeX
rejects), real `<table>` grids for tabulars with editable cells, and figure
widgets with editable captions.

Re-editing does not re-render the world. `ReconcileContext` patches the
existing DOM in place and records what changed:

- **pieces**: every rendered text node registers a *piece* keyed by the
  original CST text node it came from (`sliceOf`). One original split across
  paragraphs yields several ordered pieces.
- **pieceEdits**: a piece whose text changed is stored as either
  `{text}` (needs escaping) or `{raw}` (already TeX).
- **insertions / deletions / touchedLists** — new DOM nodes to materialise,
  removed slots, and the CST lists whose children changed.

On flush, `commit()` rebuilds the touched CST lists (splicing new text nodes
with proper escaping at the edited positions) and marks the rebuilt nodes
**dirty**, which is what makes the printer re-emit them. The dirty flag is
propagated to the nearest ancestor that owns the list — losing this step was
the single most instructive bug in the project: edits appeared in the DOM but
silently vanished from the printed source.

Typing inside a word uses **minimal-diff patching** (`patchTextValue`):
the common prefix/suffix of the old and new display text is found in
whitespace-collapsed space, mapped back to raw offsets, and only the middle
is replaced — so retyping one word edits a few characters of source instead
of reflowing the paragraph and destroying line breaks elsewhere.

## 4. Structural edits: splice, don't mutate

`web/js/visual/editor.js`

Commands that change the shape of the document (bold a selection, change a
heading level, indent a list item, add a table column, insert a figure) do
not try to mutate the CST in place. They compute exact source ranges from
the CST spans and **splice the source string**, then reparse:

```js
edits = [{ start, end, text }, …]      // non-overlapping, ascending
this.splice(edits, { caret, kind });   // flush → splice → reparse → rerender
```

This keeps structural edits trivially correct (the new source is *always*
exactly what you would have typed by hand) at the cost of one reparse —
parsing a whole document is a few milliseconds, so it is invisible.

Typing, by contrast, uses the reconcile path above so it stays cheap and
undo-coalesced. Both paths funnel through `Doc.mutate()`, which owns
parsing, history (undo groups typed characters within 700 ms) and the
`labels / outline / refs / citeNumbers` index rebuilt from the `.aux` file
after each compile.

## 5. The backend

`server/app.py`, `projects.py`, `compiler.py`, `templates.py`

A single-threaded-dependency-free Python service (stdlib only):

- **Projects** are directories under `projects/`; a `.atex/settings.json`
  holds per-project settings (main file, engine). All paths go through
  `Project.safe_path`, which refuses absolute paths, `..` traversal and
  access to `.atex` internals.
- **Compilation** prefers `latexmk` (handles re-runs itself) and falls back
  to a manual pass loop that reruns while the log says “Rerun” / labels
  changed. Kpathsea environment variables (`TEXINPUTS`, `TEXMFHOME`, …) get
  the project directory *plus a trailing empty element* — the trailing `:`
  is what tells kpathsea to keep searching the default tree; without it,
  `article.cls` stops being found.
- **Pages** are rendered by `pdftocairo -svg` (vector, one file per page,
  rendered lazily by the browser) with a `pdftoppm` PNG fallback.
- **SyncTeX**: forward search (`synctex view`) maps source line → PDF
  page/x/y, inverse (`synctex edit`) maps a click → source line. Note the
  units: SyncTeX works in TeX points (72.27/in), PDFs in big points (72/in)
  — one scale factor, easy to lose an afternoon to.
- **Math previews**: `/api/math/svg` renders a snippet with the project's
  own preamble so user macros work. Standalone snippets are wrapped in a
  minimal `standalone` document using `$\displaystyle …$` — the class
  rejects display environments — and blank lines are collapsed first.
- The **`.aux` file** of the latest build is returned with every compile
  response; the front end parses `\newlabel`/`\bibcite` (natbib nests its
  labels in braces) so `\ref`/`\cite` chips show resolved numbers.

## 6. Testing strategy

- **Core round-trip tests** (`tests/core.test.js`) run the real browser
  modules under QuickJS via a tiny ES-module bundler
  (`python3 tests/jsrunner.py`). They cover parsing/tiling/reprint,
  escaping, history, and the exact bytes produced by visual edits
  (bold/unbold, headings, list nesting, table edits, …).
- **API integration tests** (`tests/test_server.py`) boot the real HTTP
  server on a temp directory and exercise the REST surface with
  `unittest` + `urllib` — project CRUD, file round-trips, traversal
  guards, ZIP import/export, and (when a TeX distribution is present)
  compile → PDF → page render.
- **Browser acceptance** was done against the live app: two-way sync,
  undo byte-equality, minimal typing diffs, and a full compile from the UI.

## 7. Deliberate limitations

- The visual editor edits a subset of LaTeX. It never *guesses* about
  constructs it does not model: they are shown as raw cards and written
  back byte-identically.
- One document per compile — no subfile magic, but multi-file `\input`
  projects are supported via the main-file setting.
- The renderer targets modern evergreen browsers (ES2020); there is no
  build step, so no transpilation either.
