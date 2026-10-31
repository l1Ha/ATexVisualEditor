/**
 * ATexVisualEditor — LaTeX knowledge base.
 *
 * Everything the editor "understands" about LaTeX lives here: how many
 * arguments each command takes, which environments are math/lists/verbatim,
 * which commands are inline formatting, and how each maps to a DOM tag.
 *
 * Arity matters for correctness of the parse: a command listed with 0
 * arguments will never swallow a following `{...}` group (which would
 * otherwise be mis-attached), while unknown commands use a greedy heuristic.
 */

// ---------------------------------------------------------------------------
// Argument signatures
// ---------------------------------------------------------------------------

/** @type {Map<string, {opt:number, req:number, greedy?:boolean, kind?:string, textArg?:number}>} */
export const COMMAND_SIGS = new Map();

function sig(names, opt, req, extra = {}) {
  for (const n of String(names).split(/\s+/)) {
    if (n) COMMAND_SIGS.set(n, { opt, req, ...extra });
  }
}

// -- zero-argument commands (never consume a following group) ----------------
sig(`par noindent indent newline linebreak nopagebreak pagebreak newpage clearpage
     cleardoublepage clearpage clearfloat bigskip medskip smallskip hfill vfill hrule
     centering raggedright raggedleft normalsize small footnotesize scriptsize
     tiny large Large LARGE huge Huge bfseries itshape ttfamily rmfamily sffamily
     upshape slshape scshape em normalfont sloppy fussy
     maketitle tableofcontents listoffigures listoftables appendix
     frontmatter mainmatter backmatter printindex printbibliography
     hline toprule midrule bottomrule hlinexcline
     quad qquad thinspace negthinspace enspace enskip
     nonumber notag displaystyle textstyle scriptstyle limits nolimits
     ignorespaces relax protect makeatletter makeatother
     and singlecolumn twocolumn columnbreak
     mathrm mathbf mathit mathsf mathtt mathcal mathbb mathfrak mathscr boldsymbol
     aa AA oe OE ae AE ss SS o O l L i j
     dag ddag copyright pounds S P textregistered texttrademark textcopyright
     ldots dots cdots vdots ddots dotsb dotsc dotsi dotsm
     LaTeX TeX LaTeXe BibTeX`,
  0, 0);

// Spacing commands written as backslash + punctuation.
sig(`, ; : ! / > = + - @ \\ *`,
  0, 0);

// -- inline formatting: one required argument, rendered as a DOM tag --------
sig(`textbf textit textsl textsc textrm textsf texttt textmd textup textnormal
     emph underline uline uuline uwave sout xout strike textsuperscript
     textsubscript textsuperscript`,
  0, 1, { kind: 'inline', tag: null });

sig('mbox fbox framebox text', 0, 1, { kind: 'inline' });
sig('hbox vbox', 0, 1, { kind: 'rawish' });
sig('ensuremath', 0, 1, { kind: 'mathwrap' });

// -- text-ish arguments: content must not be parsed as prose ---------------
sig('label', 0, 1, { kind: 'textarg' });
sig('ref pageref eqref autoref cref Cref vref nameof', 0, 1, { kind: 'ref', textArg: 0 });
sig('cite citep citet citealp citeauthor citeyear citeyearpar nocite Cite Parencite Textcite footcite footcitetext supercite', 2, 1, { kind: 'cite', textArg: 1 });
sig('citeA citeN shortcite', 2, 1, { kind: 'cite', textArg: 1 });
sig('url path nolinkurl doi', 0, 1, { kind: 'url', textArg: 0 });
sig('href', 0, 2, { kind: 'href', textArg: 0 });
sig('includegraphics', 1, 1, { kind: 'image', textArg: 0 });
sig('bibliography bibliographystyle addbibresource includeonly documentclass', 0, 1, { kind: 'textarg' });
sig('input include subfile import', 0, 1, { kind: 'filearg', textArg: 0 });
sig('usepackage RequirePackage', 1, 1, { kind: 'textarg' });
sig('verb', 0, 0, { kind: 'verb', verbatimArg: true });
sig('verb*', 0, 0, { kind: 'verb', verbatimArg: true });
sig('def', 0, 0, { kind: 'macrodef' });
sig('newcommand renewcommand providecommand DeclareRobustCommand newenvironment renewenvironment', 1, 2, { kind: 'macrodef' });
sig('newtheorem', 1, 2, { kind: 'textarg' });
sig('setlength addtolength', 0, 2, { kind: 'textarg' });
sig('vspace hspace vskip hskip vspace* hspace*', 0, 1, { kind: 'textarg' });
sig('rule', 1, 2, { kind: 'textarg' });
sig('caption', 1, 1, { kind: 'caption' });
sig('footnote footnotemark', 1, 1, { kind: 'footnote' });
sig('thanks', 0, 1, { kind: 'footnote' });
sig('textcolor colorbox', 1, 2, { kind: 'inline' });
sig('fcolorbox', 2, 3, { kind: 'inline' });
sig('color', 1, 0, { kind: 'zeroish' });
sig('title author date thanks institute affiliation email', 0, 1, { kind: 'textarg' });
sig('hypersetup', 1, 0, { kind: 'textarg' });
sig('geometry', 1, 0, { kind: 'textarg' });
sig('graphicspath', 0, 1, { kind: 'textarg' });
sig('captionsetup', 1, 0, { kind: 'textarg' });
sig('lstset', 1, 0, { kind: 'textarg' });
sig('tikzset', 1, 0, { kind: 'textarg' });
sig('pgfplotset', 1, 0, { kind: 'textarg' });
sig('renewcommand*', 1, 2, { kind: 'macrodef' });
sig('newcommand*', 1, 2, { kind: 'macrodef' });
sig('section* subsection* subsubsection* paragraph* subparagraph* chapter* part*', 1, 1, { kind: 'section' });
sig('section subsection subsubsection paragraph subparagraph chapter part', 1, 1, { kind: 'section' });
sig('multirow multicolumn', 1, 2, { kind: 'tabular' });
sig('cline hlinex', 0, 1, { kind: 'tabular' });
sig('linebreak nolinebreak pagebreak nopagebreak', 1, 0, { kind: 'zeroish' });
sig('citealt citetext citep*', 2, 1, { kind: 'cite' });
sig('mathbbm mathbbm', 0, 1, { kind: 'mathwrap' });
sig('mathrm', 0, 1, { kind: 'mathwrap' });
sig('SI num qty ang', 1, 1, { kind: 'textarg' });
sig('todo', 1, 1, { kind: 'note' });
sig('notecite', 2, 1, { kind: 'cite' });
sig('ac gls Gls glspl acrshort acrlong', 1, 1, { kind: 'ref' });
sig('citeyearpar', 2, 1, { kind: 'cite' });
sig('hphantom vphantom phantom', 0, 1, { kind: 'inline' });
sig('overbrace underbrace', 0, 1, { kind: 'mathwrap' });
sig('xspace', 0, 0);
sig('index', 0, 1, { kind: 'textarg' });
sig('marginpar', 1, 1, { kind: 'note' });
sig('item', 1, 0, { kind: 'item' });
sig('captionof', 1, 1, { kind: 'caption' });
sig('intertext shortintertext', 0, 1, { kind: 'textarg' });
sig('tag', 0, 1, { kind: 'textarg' });
sig('vspace', 0, 1, { kind: 'textarg' });
sig('titleformat titlespacing', 2, 1, { kind: 'textarg' });
sig('let futurelet', 0, 0, { kind: 'macrodef' });
sig('newif', 0, 1, { kind: 'textarg' });
sig('ifthenelse', 0, 3, { kind: 'textarg' });
sig('IfFileExists', 0, 3, { kind: 'textarg' });
sig('write immediate', 0, 1, { kind: 'textarg' });
sig('newcounter setcounter addtocounter stepcounter refstepcounter', 0, 1, { kind: 'textarg' });
sig('arabic roman Roman alph Alph fnsymbol', 0, 1, { kind: 'ref' });
sig('clearpage', 0, 0);
sig('tableofcontents*', 0, 0);
sig('twocolumn', 1, 0);
sig('documentclass*', 1, 1, { kind: 'textarg' });

/** The signature for a command name, or null when unknown. */
export function commandSig(name) {
  return COMMAND_SIGS.get(name) || null;
}

/** How many braced groups an unknown command may greedily absorb. */
export const UNKNOWN_COMMAND_MAX_ARGS = 6;

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

/** @type {Map<string, {math?:boolean, verbatim?:boolean, list?:string, kind?:string, args?:{opt:number,req:number}}>} */
export const ENVIRONMENT_INFO = new Map();

function env(names, info = {}) {
  for (const n of String(names).split(/\s+/)) {
    if (n) ENVIRONMENT_INFO.set(n, info);
  }
}

// Math environments render as display math.
env(`equation equation* align align* alignat alignat* gather gather* multline multline*
     flalign flalign* displaymath math eqnarray eqnarray* split cases array matrix
     pmatrix bmatrix Bmatrix vmatrix Vmatrix smallmatrix subequations
     dmath dmath* dgroup`,
  { math: true });

env('math', { math: true, inline: true });

// Verbatim-ish: content is never parsed.
env(`verbatim verbatim* Verbatim BVerbatim LVerbatim lstlisting minted comment
     filecontents filecontents* alltt SaveVerbatim boxedverbatim spverbatim
     pythoncode luacode sagetex tikzcd`,
  { verbatim: true });

// Lists.
env('itemize', { list: 'itemize' });
env('enumerate', { list: 'enumerate' });
env('description', { list: 'description' });
env('list', { list: 'list', args: { opt: 1, req: 2 } });
env('enumerate*', { list: 'enumerate' });
env('itemize*', { list: 'itemize' });
env('compactitem', { list: 'itemize' });
env('compactenum', { list: 'enumerate' });

// Floats and tables.
//
// `table` and `tabular` are different things and must not be conflated:
// `table` is a float (a caption, a label, and a grid inside), while `tabular`
// is the grid itself.  Treating `table` as a grid used to swallow its whole
// body into a single cell.
env('figure figure* wrapfigure sidewaysfigure subfigure subcaptionblock SCfigure',
  { kind: 'figure', args: { opt: 1, req: 0 } });
env('table table* sidewaystable',
  { kind: 'tablefloat', args: { opt: 1, req: 0 } });
env('tabular array tabbing tblr',
  { kind: 'tabular', args: { opt: 0, req: 1 } });
env('tabularx', { kind: 'tabular', args: { opt: 0, req: 2 } });
env('tabular*', { kind: 'tabular', args: { opt: 0, req: 2 } });
env('longtable', { kind: 'tabular', args: { opt: 1, req: 1 } });
env('minipage', { kind: 'block', args: { opt: 1, req: 1 } });
env('center', { kind: 'center' });
env('flushleft', { kind: 'left' });
env('flushright', { kind: 'right' });
env('quote quotation verse displayquote', { kind: 'quote' });
env('abstract', { kind: 'abstract' });
env('titlepage', { kind: 'plain' });
env('thebibliography', { kind: 'plain', args: { opt: 0, req: 1 } });
env('appendix', { kind: 'plain' });
env('document', { kind: 'plain' });
env(`tikzpicture pgfpicture axis picture picture* forest
     algorithmic algorithmicx algorithm algorithm* listing lstlisting`,
  { kind: 'rawblock' });
env('proof theorem lemma corollary proposition definition remark example exercise claim',
  { kind: 'theorem', args: { opt: 1, req: 0 } });
env('frame block alertblock exampleblock columns column', { kind: 'block', args: { opt: 1, req: 0 } });
env('sloppypar', { kind: 'plain' });
env('trim', { kind: 'inline-env' });

/** Environment info, or null when unknown. */
export function environmentInfo(name) {
  return ENVIRONMENT_INFO.get(name) || null;
}

/** Environments whose body must be copied verbatim (never parsed). */
export const VERBATIM_ENVS = new Set(
  [...ENVIRONMENT_INFO].filter(([, v]) => v.verbatim).map(([k]) => k)
);

/** Environments that count as math for the outline / marks. */
export const MATH_ENVS = new Set(
  [...ENVIRONMENT_INFO].filter(([, v]) => v.math).map(([k]) => k)
);

// ---------------------------------------------------------------------------
// Sectioning
// ---------------------------------------------------------------------------

export const SECTION_LEVELS = {
  part: 0,
  chapter: 0,
  section: 1,
  subsection: 2,
  subsubsection: 3,
  paragraph: 4,
  subparagraph: 5,
};

export const LEVEL_NAMES = ['part', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph'];

// ---------------------------------------------------------------------------
// Inline marks: command -> DOM representation
// ---------------------------------------------------------------------------

/** Commands that render as an inline element wrapping their last argument. */
export const INLINE_TAGS = {
  textbf: 'strong',
  textit: 'em',
  textsl: 'i',
  emph: 'em',
  underline: 'u',
  uline: 'u',
  texttt: 'code',
  textsc: 'span',
  textrm: 'span',
  textsf: 'span',
  textmd: 'span',
  textup: 'span',
  textnormal: 'span',
  textsuperscript: 'sup',
  textsubscript: 'sub',
  sout: 's',
  xout: 's',
  strike: 's',
  mbox: 'span',
  fbox: 'span',
  ensuremath: 'span',
  textcolor: 'span',
  colorbox: 'span',
  href: 'a',
  url: 'a',
  nolinkurl: 'span',
};

/** Commands that carry a semantic DOM class (kept as spans for styling). */
export const INLINE_CLASSES = {
  textsc: 'tex-smallcaps',
  textrm: 'tex-rm',
  textsf: 'tex-sf',
  textmd: 'tex-md',
  textup: 'tex-up',
  textnormal: 'tex-normal',
  fbox: 'tex-fbox',
  mbox: 'tex-mbox',
  textcolor: 'tex-colored',
  colorbox: 'tex-colorbox',
  nolinkurl: 'tex-url',
};

/** Commands whose argument is rendered from a command-name table. */
export const MATH_WRAP_COMMANDS = new Set(['ensuremath', 'mathbb', 'mathrm', 'boldsymbol', 'overline', 'underbrace', 'overbrace', 'operatorname', 'text']);

// ---------------------------------------------------------------------------
// Structural / document-level commands
// ---------------------------------------------------------------------------

export const DOCUMENT_STRUCTURE_COMMANDS = new Set([
  'maketitle', 'tableofcontents', 'listoffigures', 'listoftables', 'appendix',
  'frontmatter', 'mainmatter', 'backmatter', 'printbibliography', 'printindex',
  'bibliography', 'newpage', 'clearpage', 'cleardoublepage', 'pagebreak',
]);

/** Commands that produce no visible output and can be hidden in the visual view. */
export const INVISIBLE_COMMANDS = new Set([
  'label', 'index', 'protect', 'relax', 'ignorespaces', 'noindent', 'makeatletter',
  'makeatother', 'graphicspath', 'bibliographystyle', 'hypersetup', 'lstset',
  'captionsetup', 'geometry', 'usepackage', 'documentclass', 'newtheorem',
  'addbibresource', 'definecolor', 'setlength', 'addtolength', 'tikzset', 'xspace',
]);

// ---------------------------------------------------------------------------
// Math symbol helpers (for the math editor's palette)
// ---------------------------------------------------------------------------

export const MATH_PALETTE = [
  { group: 'Greek', items: ['\\alpha', '\\beta', '\\gamma', '\\delta', '\\epsilon', '\\zeta', '\\eta', '\\theta', '\\iota', '\\kappa', '\\lambda', '\\mu', '\\nu', '\\xi', '\\pi', '\\rho', '\\sigma', '\\tau', '\\upsilon', '\\phi', '\\chi', '\\psi', '\\omega', '\\Gamma', '\\Delta', '\\Theta', '\\Lambda', '\\Xi', '\\Pi', '\\Sigma', '\\Upsilon', '\\Phi', '\\Psi', '\\Omega'] },
  { group: 'Operators', items: ['\\sum', '\\prod', '\\int', '\\oint', '\\iint', '\\frac{}{}', '\\sqrt{}', '\\sqrt[3]{}', '\\partial', '\\nabla', '\\infty', '\\pm', '\\mp', '\\times', '\\div', '\\cdot', '\\ast', '\\circ', '\\bullet', '\\oplus', '\\otimes'] },
  { group: 'Relations', items: ['=', '\\neq', '\\approx', '\\equiv', '\\cong', '\\sim', '\\simeq', '\\propto', '\\leq', '\\geq', '\\ll', '\\gg', '\\subset', '\\subseteq', '\\supset', '\\in', '\\notin', '\\ni', '\\to', '\\rightarrow', '\\leftarrow', '\\Rightarrow', '\\Leftarrow', '\\leftrightarrow', '\\mapsto'] },
  { group: 'Structures', items: ['\\begin{matrix} \\end{matrix}', '\\begin{pmatrix} \\end{pmatrix}', '\\begin{bmatrix} \\end{bmatrix}', '\\begin{cases} \\end{cases}', '\\begin{align} \\end{align}', '\\vec{}', '\\hat{}', '\\bar{}', '\\dot{}', '\\ddot{}', '\\tilde{}', '\\overline{}', '\\underline{}', '\\left( \\right)', '\\left[ \\right]', '\\left\\{ \\right\\}', '\\binom{}{}'] },
  { group: 'Functions', items: ['\\sin', '\\cos', '\\tan', '\\log', '\\ln', '\\exp', '\\lim', '\\lim_{n \\to \\infty}', '\\max', '\\min', '\\sup', '\\inf', '\\det', '\\mod', '\\bmod', '\\operatorname{}'] },
];

export const BIB_ENTRY_TYPES = [
  'article', 'book', 'booklet', 'conference', 'inbook', 'incollection', 'inproceedings',
  'manual', 'mastersthesis', 'misc', 'phdthesis', 'proceedings', 'techreport', 'unpublished',
  'online', 'patent', 'periodical', 'standard', 'thesis', 'report',
];

/** Fields shown in the visual reference/citation editor, in order. */
export const BIB_FIELDS = [
  'author', 'title', 'journal', 'booktitle', 'year', 'volume', 'number', 'pages',
  'publisher', 'address', 'edition', 'month', 'note', 'doi', 'url', 'isbn', 'editor',
  'series', 'chapter', 'school', 'institution', 'organization', 'howpublished',
];
