"""
ATexVisualEditor — starter documents.

Templates are plain `{path: source}` dictionaries, so they are easy to read and
easy to extend.  Every one of them is verified to compile with pdfLaTeX as part
of the test suite, and each is written to exercise a different part of the
editor (math, figures, tables, cross-references, citations, multi-file input).
"""

from __future__ import annotations

from typing import Any

# ---------------------------------------------------------------------------
# Welcome — the guided demo project
# ---------------------------------------------------------------------------

WELCOME_MAIN = r"""\documentclass[11pt,a4paper]{article}

% ---------------------------------------------------------------------------
% Welcome to ATexVisualEditor.
%
% Switch to the Visual tab and edit this document like a word processor: the
% LaTeX below stays in sync, and anything the editor does not understand is
% left exactly as it was written.
% ---------------------------------------------------------------------------

\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage[a4paper,margin=2.5cm]{geometry}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage{xcolor}
\usepackage[round]{natbib}
\usepackage[
  colorlinks=true,
  linkcolor=teal,
  citecolor=teal,
  urlcolor=teal
]{hyperref}

\title{Getting Started with \textbf{ATexVisualEditor}}
\author{You \\ \small\texttt{you@example.org}}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
This document is both a demonstration and a test bench.  Edit any paragraph in
the visual view, add a section from the toolbar, type \verb|$e^{i\pi}+1=0$| to
see math rendered, and watch the PDF on the right rebuild by itself.
\end{abstract}

\tableofcontents

\section{What this editor does}
\label{sec:what}

The visual view is not a separate document: it is a projection of the same
LaTeX source that the \emph{Source} tab shows.  Words, \textbf{bold text},
\textit{italics}, \underline{underlining} and \texttt{monospace} are edited
directly, while commands the editor does not model are carried through
untouched.

Three things are worth trying:

\begin{itemize}
  \item Select some text and press \textbf{Ctrl+B} or \textbf{Ctrl+I}.
  \item Press \textbf{Enter} twice to start a new paragraph; press
        \textbf{Tab} inside a list to nest an item.
  \item Click a citation such as \citep{knuth1984} to edit it, including
        entries from \texttt{references.bib}.
\end{itemize}

Alternatively, use a numbered list:

\begin{enumerate}
  \item Write in the visual view.
  \item Check the compiled result in the PDF pane.
  \item Use \textbf{Ctrl+Shift+S} to jump between source, visual and PDF.
\end{enumerate}

\section{Mathematics}
\label{sec:math}

Inline mathematics such as $e^{i\pi} + 1 = 0$ is rendered as you type, and
display equations get their own block, for instance the Gaussian integral in
Equation~\eqref{eq:gauss}:

\begin{equation}
  \label{eq:gauss}
  \int_{-\infty}^{\infty} e^{-x^{2}}\,\mathrm{d}x = \sqrt{\pi}.
\end{equation}

A matrix and an aligned derivation:

\begin{align}
  \mathbf{A}\mathbf{x} &= \mathbf{b}, \label{eq:system} \\
  \mathbf{x} &= \mathbf{A}^{-1}\mathbf{b}
               = \frac{1}{\det \mathbf{A}}
                 \begin{pmatrix} d & -b \\ -c & a \end{pmatrix} \mathbf{b}.
\end{align}

\section{A figure and a table}
\label{sec:figure}

Figure~\ref{fig:plot} is a real image file in this project
(\texttt{figures/plot.png}); select it in the visual view to change its width,
its caption or its label.

\begin{figure}[htbp]
  \centering
  \includegraphics[width=0.72\textwidth]{figures/plot.png}
  \caption{Measured signal together with the fitted trend line.\label{fig:plot}}
\end{figure}

Tables are edited as tables in the visual view — add rows and columns, change
the alignment and the rules, and the \texttt{tabular} code follows
(Table~\ref{tab:measurements}).

\begin{table}[htbp]
  \centering
  \caption{Calibration measurements.\label{tab:measurements}}
  \begin{tabular}{lrrr}
    \toprule
    Sample & Thickness (mm) & Mass (g) & Density (g/cm$^{3}$) \\
    \midrule
    A & 1.20 & 2.41 & 2.01 \\
    B & 1.35 & 2.89 & 2.14 \\
    C & 1.48 & 3.02 & 2.04 \\
    \bottomrule
  \end{tabular}
\end{table}

\subsection{A subsection with a footnote}
\label{sec:footnote}

Footnotes work as expected\footnote{Like this one — stored as a
\texttt{\textbackslash footnote} command right where the marker sits.}, and so
do links: see \href{https://example.com}{example.com} or the bare URL
\url{https://example.com/docs}.

\section{Where to go next}
\label{sec:next}

Add a bibliography entry to \texttt{references.bib} and cite it with the
\textbf{Cite} button, or press \textbf{Ctrl+K} to open the command palette.
When something goes wrong, the build log below the PDF pane lists every error
with a line number you can click.

\bibliographystyle{plainnat}
\bibliography{references}

\end{document}
"""

WELCOME_REFERENCES = r"""@book{knuth1984,
  author    = {Knuth, Donald E.},
  title     = {The {\TeX}book},
  publisher = {Addison-Wesley},
  year      = {1984},
  address   = {Reading, Massachusetts},
  isbn      = {0-201-13447-0}
}

@book{lamport1994,
  author    = {Lamport, Leslie},
  title     = {{\LaTeX}: A Document Preparation System},
  edition   = {2},
  publisher = {Addison-Wesley},
  year      = {1994}
}

@article{small2020,
  author  = {Small, Anita and Petite, Jean},
  title   = {On the measurement of very small things},
  journal = {Journal of Precision Instrumentation},
  volume  = {12},
  number  = {3},
  pages   = {221--240},
  year    = {2020},
  doi     = {10.1000/jpi.2020.12.3.221}
}

@inproceedings{smith2000,
  author    = {Smith, John and Jones, Mary},
  title     = {A fast algorithm for slow problems},
  booktitle = {Proceedings of the International Conference on Algorithms},
  pages     = {45--56},
  year      = {2000},
  publisher = {ACM}
}
"""

# ---------------------------------------------------------------------------
# Other templates
# ---------------------------------------------------------------------------

ARTICLE_MAIN = r"""\documentclass[11pt,a4paper]{article}

\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage[a4paper,margin=2.5cm]{geometry}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage{microtype}
\usepackage[hidelinks]{hyperref}

\title{Title of the Paper}
\author{First Author \and Second Author}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
A short summary of the work, its method and its main result.
\end{abstract}

\section{Introduction}
\label{sec:intro}
Start writing here.

\section{Method}
\label{sec:method}
Describe the method.  Display equations are written like this:
\begin{equation}
  \label{eq:main}
  f(x) = \sum_{i=0}^{n} a_i x^i .
\end{equation}

\section{Results}
\label{sec:results}
Present the results and refer to them as Equation~\eqref{eq:main}.

\section{Conclusion}
\label{sec:conclusion}
Summarise the findings.

\end{document}
"""

REPORT_FILES = {
    "main.tex": r"""\documentclass[12pt,a4paper]{report}

\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage[a4paper,margin=3cm]{geometry}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage[hidelinks]{hyperref}

\title{Project Report}
\author{Your Name}
\date{\today}

\begin{document}
\maketitle
\tableofcontents

\include{chapters/introduction}
\include{chapters/method}

\appendix
\include{chapters/appendix}

\end{document}
""",
    "chapters/introduction.tex": r"""\chapter{Introduction}
\label{ch:introduction}

Chapters live in their own files and are pulled in with \verb|\include|, which
is why the file tree on the left matters: open \texttt{chapters/method.tex} to
edit the next chapter.

\section{Background}
\label{sec:background}
Write the background here.
""",
    "chapters/method.tex": r"""\chapter{Method}
\label{ch:method}

\section{Approach}
\label{sec:approach}
Describe the approach, with mathematics when it helps:
\begin{equation}
  \label{eq:objective}
  \mathcal{L}(\theta) = \frac{1}{N}\sum_{i=1}^{N}
      \bigl\lVert y_i - f_\theta(x_i) \bigr\rVert_2^2 .
\end{equation}

\section{Implementation}
\label{sec:implementation}
Describe the implementation.
""",
    "chapters/appendix.tex": r"""\chapter{Supporting Material}
\label{ch:appendix}

Additional derivations, tables and figures.
""",
}

BEAMER_MAIN = r"""\documentclass[aspectratio=169]{beamer}

\usetheme{default}
\usecolortheme{seahorse}
\usepackage{amsmath}

\title{A Short Talk}
\subtitle{With a subtitle}
\author{Your Name}
\date{\today}

\begin{document}

\begin{frame}
  \titlepage
\end{frame}

\begin{frame}{Outline}
  \tableofcontents
\end{frame}

\section{Motivation}

\begin{frame}{Why this matters}
  \begin{itemize}
    \item The first reason, stated plainly.
    \item The second reason, with a reference to \textbf{bold text}.
  \end{itemize}
\end{frame}

\section{Results}

\begin{frame}{What we found}
  \begin{block}{Main result}
    The key quantity grows linearly, as in
    $y = \alpha x + \beta$.
  \end{block}
  \begin{itemize}
    \item Fits the prediction.
  \end{itemize}
\end{frame}

\begin{frame}{Thank you}
  Questions?
\end{frame}

\end{document}
"""

BLANK_MAIN = r"""\documentclass[11pt]{article}

\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage[hidelinks]{hyperref}

\title{Untitled}
\author{}
\date{\today}

\begin{document}
\maketitle

Write your document here.

\end{document}
"""

LETTER_MAIN = r"""\documentclass[11pt]{letter}

\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage[margin=2.5cm]{geometry}

\signature{Your Name}
\address{Your Street 1 \\ 12345 Your City}

\begin{document}

\begin{letter}{Recipient Name \\ Recipient Street 2 \\ 54321 Recipient City}
\opening{Dear Recipient,}

This is the body of the letter.  It can be edited in the visual view like any
other document.

\closing{Yours sincerely,}
\end{letter}

\end{document}
"""

MULTILINGUAL_MAIN = r"""\documentclass[11pt]{article}

% XeLaTeX or LuaLaTeX are needed for system fonts; choose them in the build
% menu in the top-right corner.  pdfLaTeX works too, but with limited glyph
% coverage.
\usepackage{fontspec}
\usepackage{polyglossia}
\setdefaultlanguage{english}
\setotherlanguage{greek}
\setmainfont{DejaVu Serif}
\newfontfamily\greekfont{DejaVu Sans}

\usepackage{amsmath}
\usepackage[hidelinks]{hyperref}

\title{多语言文档 / Multilingual document}
\author{}
\date{\today}

\begin{document}
\maketitle

\section{Unicode text}
Du texte accentué, des caractères grecs et cyrilliques, et du chinois :
\textgreek{α β γ δ}, привет, 你好世界.

\section{Math}
$\displaystyle \oint_{\partial \Omega} \omega = \int_{\Omega} \mathrm{d}\omega$

\end{document}
"""

TEMPLATES: dict[str, dict[str, str]] = {
    "welcome": {"main.tex": WELCOME_MAIN, "references.bib": WELCOME_REFERENCES},
    "article": {"main.tex": ARTICLE_MAIN},
    "report": REPORT_FILES,
    "beamer": {"main.tex": BEAMER_MAIN},
    "letter": {"main.tex": LETTER_MAIN},
    "multilingual": {"main.tex": MULTILINGUAL_MAIN},
    "blank": {"main.tex": BLANK_MAIN},
}

TEMPLATE_INFO = [
    {
        "id": "article",
        "name": "Article",
        "description": "Standard journal-style article with abstract, sections and an equation",
    },
    {
        "id": "report",
        "name": "Report (multi-file)",
        "description": "A report split into chapters, one file each, pulled in with \\include",
    },
    {
        "id": "beamer",
        "name": "Beamer presentation",
        "description": "Slides with sections, blocks and item lists",
    },
    {
        "id": "letter",
        "name": "Letter",
        "description": "Formal letter using the letter class",
    },
    {
        "id": "multilingual",
        "name": "Multilingual (Unicode)",
        "description": "Fontspec/polyglossia document — build with XeLaTeX or LuaLaTeX",
    },
    {
        "id": "blank",
        "name": "Blank",
        "description": "A minimal empty document",
    },
]


def template_files(template: str, *, title: str = "", **_: Any) -> dict[str, str]:
    """Files for a named template (a copy is returned so callers can mutate it)."""
    files = dict(TEMPLATES.get(template, TEMPLATES["blank"]))
    if title:
        files = {path: text.replace("Untitled", title) for path, text in files.items()}
    return files
