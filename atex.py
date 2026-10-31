#!/usr/bin/env python3
"""
ATexVisualEditor — launcher.

    python3 atex.py                 # start and open the editor
    python3 atex.py --port 3000     # choose a port
    python3 atex.py --host 0.0.0.0  # reach it from a tablet or another machine
    python3 atex.py --check         # report which LaTeX tools were found

Requires Python 3.9+ and a TeX distribution (TeX Live, MiKTeX or MacTeX) for
compilation.  The visual editor, the source editor and project management work
without TeX — only the PDF preview needs it.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from server.app import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
