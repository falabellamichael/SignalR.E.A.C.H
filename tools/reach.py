#!/usr/bin/env python3
"""SimpleREACH installer + runtime manager — thin launcher shim.

The implementation lives in the ``reach`` package next to this file;
this shim exists so every documented ``python tools/reach.py ...``
command keeps working unchanged.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from reach.cli import main  # noqa: E402

if __name__ == "__main__":
    main()
