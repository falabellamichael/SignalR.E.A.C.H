#!/usr/bin/env python3
"""`signalreach`: start the SignalREACH relay (see tools/reach/command.py)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from reach.command import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
