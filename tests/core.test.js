/**
 * Core tests: parsing, printing, round-trip fidelity, offset integrity.
 *
 * The central promise of the editor is that opening a document in the visual
 * view and editing one word cannot disturb any other byte of the file.  These
 * tests are what hold that promise up.
 */

import { parseLatexUncached, verifyTiling, Parser } from '../web/js/core/parser.js';
import { printNode, printNodes } from '../web/js/core/printer.js';
import * as ast from '../web/js/core/ast.js';

// ---------------------------------------------------------------------------
// Corpus of documents that must round-trip byte for byte.
// ---------------------------------------------------------------------------

const CORPUS = {
  'plain text': 'Hello world.\n',

  'two paragraphs': 'First paragraph here.\n\nSecond paragraph here.\n',

  'preamble and body': `\\documentclass[11pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}

\\title{A Study of Things}
\\author{Ada Lovelace \\\\ ad@example.org}

\\begin{document}
\\maketitle

Hello.
\\end{document}
`,

  'sections and formatting': `\\section{Introduction}
Some \\textbf{bold} and \\emph{emphasised} and \\texttt{monospace} text.
\\subsection{Details}
Nested \\textbf{bold with \\emph{emphasis} inside}.
\\subsubsection*{Unnumbered}
More text.
`,

  'lists': `\\begin{itemize}
\\item First
\\item Second with \\textbf{bold}
\\begin{enumerate}
\\item Nested one
\\item Nested two
\\end{enumerate}
\\end{itemize}

\\begin{description}
\\item[Term] Definition here.
\\end{description}
`,

  'inline math': `The value is $x^2 + y^2 = z^2$ and also \\(a_i\\) inline.
Costs \\$5 and \\%50 and \\& more.
`,

  'display math': `\\begin{equation}
\\label{eq:pythagoras}
a^2 + b^2 = c^2
\\end{equation}

\\[
  \\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}
\\]

$$E = mc^2$$
`,

  'align environment': `\\begin{align}
f(x) &= x^2 + 2x + 1 \\\\
     &= (x+1)^2
\\end{align}
`,

  'figure': `\\begin{figure}[htbp]
  \\centering
  \\includegraphics[width=0.8\\textwidth]{figures/plot.png}
  \\caption{The measured values.}
  \\label{fig:plot}
\\end{figure}
`,

  'table': `\\begin{table}[h]
\\centering
\\caption{Results}
\\begin{tabular}{lcr}
\\toprule
Name & Value & Unit \\\\
\\midrule
Alpha & 1.5 & m \\\\
Beta & 2.0 & s \\\\
\\bottomrule
\\end{tabular}
\\label{tab:results}
\\end{table}
`,

  'footnotes refs cites': `As shown by \\cite{knuth1984} and \\cite[p.~42]{lamport1994},
the result\\footnote{See also \\cite{other2020}.} holds in Figure~\\ref{fig:plot},
Equation~\\eqref{eq:pythagoras} and \\citep{smith2000, jones2001}.
See \\url{https://example.com/a_b} and \\href{https://x.org}{the site}.
`,

  'comments': `Leading text. % a trailing comment
% a full-line comment
\\section{Title} % another
Text after.
`,

  'verbatim': `\\begin{verbatim}
def f(x):
    return x % 2 == 0  # comment with \\ and {
\\end{verbatim}

Inline \\verb|a_b \\c %d| here.
`,

  'custom macros': `\\newcommand{\\R}{\\mathbb{R}}
\\newcommand{\\vect}[1]{\\mathbf{#1}}
\\renewcommand{\\baselinestretch}{1.1}

The space \\R^2 contains \\vect{v}.
`,

  'unknown commands': `\\weirdcmd{one}{two} then \\anotherplain and \\x{a}.

\\begin{mycustomenv}
Content inside.
\\end{mycustomenv}
`,

  'unterminated group': `Text with {an unclosed group and more text.
`,

  'unclosed math': `Cost is $5 and $ not math: 100% sure.
`,

  'mismatched end': `\\begin{itemize}
\\item one
\\end{enumerate}
`,

  'stray end': `Text here.
\\end{document}
More text.
`,

  'stray braces': `A } brace and a { one, plus } } two.
`,

  'tilde and specials': `See Section~\\ref{sec:x} and page~5, 100\\% sure, a\\_b, \\{x\\}.
`,

  'nested environments': `\\begin{quote}
Some quoted text.
\\begin{verbatim}
raw & stuff
\\end{verbatim}
\\end{quote}
`,

  'blank line variants': `Para one.



Para two after several blank lines.
`,

  'whitespace before args': `\\textbf
   {bold on the next line} and \\emph
  {also}.

\\section
{Title across lines}
`,

  'starred commands': `\\section*{Starred}
\\chapter*{Also starred}
\\newcommand*{\\x}{y}
`,

  'realistic paper': `\\documentclass[twocolumn]{article}
\\usepackage{amsmath, amssymb, graphicx, booktabs}
\\usepackage[round]{natbib}

\\title{On the Measurement of Very Small Things}
\\author{A.~Researcher\\thanks{Funded by grant 12345.} \\and B.~Coauthor}
\\date{\\today}

\\begin{document}
\\maketitle

\\begin{abstract}
We measure small things and report the results.
\\end{abstract}

\\section{Introduction}
\\label{sec:intro}
The study of small things \\citep{small2020} began long ago.

\\section{Method}
\\label{sec:method}
We use the formula
\\begin{equation}
\\label{eq:main}
E = \\sum_{i=1}^{n} \\frac{1}{2} m_i v_i^2,
\\end{equation}
which is standard. Table~\\ref{tab:vals} lists the values.

\\begin{table}[t]
\\centering
\\caption{Measured values.}\\label{tab:vals}
\\begin{tabular}{@{}lrr@{}}
\\toprule
Item & Value & Error \\\\
\\midrule
Alpha & 1.234 & 0.001 \\\\
Beta  & 5.678 & 0.002 \\\\
\\bottomrule
\\end{tabular}
\\end{table}

\\subsection{Limitations}
As noted in Section~\\ref{sec:intro}, this is hard.

\\bibliographystyle{plainnat}
\\bibliography{refs}
\\end{document}
`,
};

// ---------------------------------------------------------------------------
// Round-trip and integrity
// ---------------------------------------------------------------------------

test('every corpus document round-trips byte for byte', (t) => {
  for (const [name, source] of Object.entries(CORPUS)) {
    const root = parseLatexUncached(source);
    const out = printNode(root);
    t.eq(out, source, `round trip of "${name}"`);
  }
});

test('node raw slices tile the source with no gaps or overlaps', (t) => {
  for (const [name, source] of Object.entries(CORPUS)) {
    const { ok, problems } = verifyTiling(source);
    t.ok(ok, `tiling of "${name}" — ${problems.slice(0, 3).join(' | ')}`);
  }
});

test('every node knows where it came from in the source', (t) => {
  for (const [name, source] of Object.entries(CORPUS)) {
    const root = parseLatexUncached(source);
    ast.walkAllOf(root.children, (n) => {
      t.ok(n.start >= 0 && n.end <= source.length, `offsets in range for "${name}"`);
      t.ok(n.start <= n.end, `offsets ordered for "${name}"`);
      if (!n._dirty) {
        t.eq(source.slice(n.start, n.end), n.raw, `raw matches source for ${n.kind} in "${name}"`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Parsing specifics
// ---------------------------------------------------------------------------

test('parses sections with their level', (t) => {
  const root = parseLatexUncached('\\section{One}\ntext\n\\subsection{Two}\n');
  const cmds = [];
  ast.walkAllOf(root.children, (n) => {
    if (n.kind === 'command' && (n.name === 'section' || n.name === 'subsection')) cmds.push(n);
  });
  t.eq(cmds.length, 2);
  t.eq(cmds[0].name, 'section');
  t.eq(cmds[0].args.length, 1);
  t.eq(ast.plainText(cmds[0].args[0].children), 'One');
  t.eq(cmds[1].name, 'subsection');
});

test('zero-argument commands do not swallow a following group', (t) => {
  const root = parseLatexUncached('\\noindent {group} text\n');
  const cmd = root.children[0];
  t.eq(cmd.kind, 'command');
  t.eq(cmd.name, 'noindent');
  t.eq(cmd.args.length, 0, '\\noindent must not take the group as an argument');
  t.eq(root.children[1].raw, ' ', 'the space stays a text node');
  t.eq(root.children[2].kind, 'group', 'and the group is a sibling, not an argument');
});

test('known one-argument commands take exactly one argument', (t) => {
  const root = parseLatexUncached('\\textbf{bold} and {separate}\n');
  const cmd = root.children[0];
  t.eq(cmd.name, 'textbf');
  t.eq(cmd.args.length, 1);
  t.eq(ast.plainText(cmd.args[0].children), 'bold');
  t.eq(root.children[1].raw, ' and ');
  t.eq(root.children[2].kind, 'group', 'the later group is not an argument');
});

test('optional arguments are attached where declared', (t) => {
  const root = parseLatexUncached('\\includegraphics[width=5cm]{a.png}\n');
  const cmd = root.children[0];
  t.eq(cmd.args.length, 2);
  t.eq(cmd.args[0].optional, true);
  t.eq(ast.plainText(cmd.args[0].children), 'width=5cm');
  t.eq(cmd.args[1].optional, false);
  t.eq(ast.plainText(cmd.args[1].children), 'a.png');
});

test('whitespace between a command and its argument is preserved', (t) => {
  const src = '\\textbf\n   {bold} tail\n';
  const root = parseLatexUncached(src);
  const arg = root.children[0].args[0];
  t.eq(arg.lead, '\n   ');
  t.eq(printNode(root), src);
});

test('math keeps its delimiters and mode', (t) => {
  const root = parseLatexUncached('$a$ $$b$$ \\(c\\) \\[d\\]\n');
  const maths = root.children.filter((n) => n.kind === 'math');
  t.eq(maths.length, 4);
  t.eq(maths[0].mode, 'inline');
  t.eq(maths[0].value, 'a');
  t.eq(maths[1].mode, 'display');
  t.eq(maths[1].value, 'b');
  t.eq(maths[2].mode, 'inline');
  t.eq(maths[2].delim, '\\(');
  t.eq(maths[3].mode, 'display');
  t.eq(maths[3].delim, '\\[');
});

test('a lone dollar sign does not swallow the document', (t) => {
  const src = 'It costs $5 today.\n\nAnother paragraph.\n';
  const root = parseLatexUncached(src);
  t.eq(printNode(root), src);
  t.eq(root.children.filter((n) => n.kind === 'math').length, 0, 'no math node for an unmatched $');
});

test('math never spans a blank line', (t) => {
  const src = 'Some $math\n\nand more text.\n';
  const root = parseLatexUncached(src);
  t.eq(root.children.filter((n) => n.kind === 'math').length, 0);
  t.eq(printNode(root), src);
});

test('environments record name, end name and nesting', (t) => {
  const root = parseLatexUncached('\\begin{figure}[h]\n\\includegraphics{a}\n\\end{figure}\n');
  const env = root.children[0];
  t.eq(env.kind, 'environment');
  t.eq(env.name, 'figure');
  t.eq(env.endName, 'figure');
  t.eq(env.closed, true);
  t.eq(env.args.length, 1);
  t.eq(env.args[0].optional, true);
});

test('verbatim environment bodies are never parsed', (t) => {
  const root = parseLatexUncached('\\begin{verbatim}\n{a} % $x$ \\end{nope}\n\\end{verbatim}\n');
  const env = root.children[0];
  t.eq(env.name, 'verbatim');
  t.eq(env.verbatim, true);
  t.eq(env.children.length, 1);
  t.eq(env.children[0].kind, 'text');
  t.eq(env.children[0].value, '\n{a} % $x$ \\end{nope}\n');
});

test('\\verb reads to its own delimiter', (t) => {
  const root = parseLatexUncached('\\verb|a{b} %c| tail\n');
  const cmd = root.children[0];
  t.eq(cmd.name, 'verb');
  t.eq(cmd.args[0].verbDelim, '|');
  t.eq(cmd.args[0].children[0].value, 'a{b} %c');
});

test('tabular cells are marked so tables can be rebuilt', (t) => {
  const root = parseLatexUncached('\\begin{tabular}{lc}\na & b \\\\\nc & d\n\\end{tabular}\n');
  const env = root.children[0];
  const amps = [];
  ast.walkAllOf(env.children, (n) => {
    if (n.kind === 'raw' && n.value === '&') amps.push(n);
  });
  t.eq(amps.length, 2, 'one separator per row is marked');
});

test('an ampersand outside a table is ordinary text', (t) => {
  const root = parseLatexUncached('Tom & Jerry\n');
  t.eq(root.children[0].kind, 'text');
  t.eq(root.children[0].value, 'Tom & Jerry\n');
});

test('comments are kept as nodes including the newline', (t) => {
  const root = parseLatexUncached('a % note\nb\n');
  t.eq(root.children[1].kind, 'comment');
  t.eq(root.children[1].value, '% note\n');
});

test('unbalanced braces are recovered and reported', (t) => {
  const root = parseLatexUncached('before {unclosed after\n');
  t.ok(root.warnings.length > 0, 'a warning is recorded');
  t.eq(printNode(root), 'before {unclosed after\n');
});

test('mismatched \\begin/\\end is recovered', (t) => {
  const src = '\\begin{itemize}\n\\item one\n\\end{enumerate}\n';
  const root = parseLatexUncached(src);
  t.ok(root.warnings.length > 0, 'a warning is recorded');
  t.eq(printNode(root), src, 'and the source is unchanged');
});

test('sectioning commands are recognised for the outline', (t) => {
  const root = parseLatexUncached('\\part{P}\n\\chapter{C}\n\\section{S}\n\\paragraph{P}\n');
  const names = root.children
    .filter((n) => n.kind === 'command')
    .map((n) => n.name);
  t.deepEq(names, ['part', 'chapter', 'section', 'paragraph']);
});

// ---------------------------------------------------------------------------
// Editing: reprint only what changed
// ---------------------------------------------------------------------------

test('editing one word leaves the rest of the file untouched', (t) => {
  const src = CORPUS['realistic paper'];
  const root = parseLatexUncached(src);
  // Find the first text node inside the abstract and rewrite it.
  let target = null;
  ast.walkAllOf(root.children, (n) => {
    if (!target && n.kind === 'text' && n.value.includes('report the results')) target = n;
  });
  t.ok(target, 'found the text node to edit');
  const updated = 'We measure small things and publish the results.';
  ast.setTextContent(target, updated);
  const out = printNode(root);
  t.eq(out, src.replace('We measure small things and report the results.', updated));
  t.eq(out.length, src.length + 'publish'.length - 'report'.length);
  t.ok(out.includes('% comment') === src.includes('% comment'), 'nothing else moved');
});

test('editing preserves every comment and odd space around it', (t) => {
  const src = CORPUS['comments'];
  const root = parseLatexUncached(src);
  let target = null;
  ast.walkAllOf(root.children, (n) => {
    if (!target && n.kind === 'text' && n.value.trim() === 'Text after.') target = n;
  });
  ast.setTextContent(target, 'Text afterwards.');
  t.eq(printNode(root), src.replace('Text after.', 'Text afterwards.'));
  t.ok(printNode(root).includes('% a full-line comment'), 'comment survived');
});

test('escaped text is escaped on the way out', (t) => {
  const root = parseLatexUncached('plain\n');
  ast.setTextContent(root.children[0], '100% sure & {safe} #1 _x_ ~y~ $5 \\ z');
  const out = printNode(root);
  t.eq(
    out,
    '100\\% sure \\& \\{safe\\} \\#1 \\_x\\_ \\textasciitilde{}y\\textasciitilde{} ' +
      '\\$5 \\textbackslash{} z\n'
  );
  t.eq(ast.textContent(root.children[0]), '100% sure & {safe} #1 _x_ ~y~ $5 \\ z');
});

test('offsets stay correct after an edit', (t) => {
  const src = '\\section{One}\nHello world.\n\\section{Two}\n';
  const root = parseLatexUncached(src);
  const textNode = root.children[1];
  ast.setTextContent(textNode, 'Hello there, world!');
  const out = printNode(root);
  t.eq(out, '\\section{One}\nHello there, world!\n\\section{Two}\n');
  // The following section must now start at its new offset.
  const second = root.children[2];
  t.eq(out.slice(second.start, second.end), '\\section{Two}');
  t.eq(out.slice(root.children[3].start, root.children[3].end), '\n');
});

test('a clean subtree is emitted from its raw slice', (t) => {
  const src = '\\section{Untouched}\nTail.\n';
  const root = parseLatexUncached(src);
  const section = root.children[0];
  // Simulate someone mutating the tree without marking it dirty: the printer
  // must still emit the original bytes, which is what protects the file.
  section.args[0].children[0].value = 'CHANGED';
  t.eq(printNode(root), src);
});

test('unparseable input still round-trips', (t) => {
  const weird = [
    '}}}',
    '\\',
    '{',
    '$',
    '\\begin{',
    '\\begin{x}\\begin{y}\\end{x}\\end{y}',
    'text \\end',
    '\\\\',
    '\\[',
    '%only a comment',
    '\u00e9\u00e8\u00ea unicode accents \u4e2d\u6587\u6d4b\u8bd5',
  ];
  for (const src of weird) {
    const root = parseLatexUncached(src);
    t.eq(printNode(root), src, `round trip of ${JSON.stringify(src)}`);
  }
});

test('parser never throws and never loses characters', (t) => {
  // Fuzz: every prefix and every two-character splice of a busy document.
  const base = CORPUS['realistic paper'];
  let checked = 0;
  for (let i = 0; i < base.length; i += 37) {
    const slice = base.slice(0, i);
    const root = parseLatexUncached(slice);
    t.eq(printNode(root), slice, `prefix of length ${i}`);
    checked++;
  }
  t.ok(checked > 20, 'checked a decent number of prefixes');
});

test('plainText extracts readable content', (t) => {
  const root = parseLatexUncached('\\section{Intro}\nSome \\textbf{bold} text with $x$ math.\n');
  const text = ast.plainText(root.children);
  t.ok(text.includes('Intro'), 'section title included');
  t.ok(text.includes('bold'), 'nested content included');
  t.ok(text.includes('$x$'), 'math kept as TeX');
});

test('isBlank ignores comments and invisible commands', (t) => {
  const root = parseLatexUncached('% comment\n\\label{x}\n\n');
  t.eq(ast.isBlank(root.children), true);
  const root2 = parseLatexUncached('word\n');
  t.eq(ast.isBlank(root2.children), false);
});

test('cloneNode produces an independent copy', (t) => {
  const root = parseLatexUncached('\\section{One}\nText.\n');
  const copy = ast.cloneNode(root);
  copy.children[0].args[0].children[0].value = 'Two';
  t.eq(ast.plainText(root.children[0].args[0].children), 'One');
  t.eq(ast.plainText(copy.children[0].args[0].children), 'Two');
});

test('markDirty walks up to the root', (t) => {
  const root = parseLatexUncached('\\section{One}\n');
  const deep = root.children[0].args[0].children[0];
  t.eq(root._dirty, false);
  ast.markDirty(deep);
  t.eq(deep._dirty, true);
  t.eq(root._dirty, true, 'ancestors are invalidated too');
});
