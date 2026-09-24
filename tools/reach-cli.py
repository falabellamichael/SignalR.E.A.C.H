#!/usr/bin/env python3
"""SignalR.E.A.C.H chat CLI — thin launcher shim.

The implementation lives in the ``reach_cli`` package next to this
file; this shim keeps every documented
``python tools/reach-cli.py ...`` command working unchanged.
Tests still load this file by path and use ``DDGParser`` /
``TextExtractor`` / ``build_grounded_messages`` from it, so those
names are re-exported here.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from reach_cli.client import ReachApiError, ReachClient  # noqa: E402
from reach_cli.__main__ import main  # noqa: E402
from reach_cli.grounding import build_grounded_messages  # noqa: E402
from reach_cli.websearch import DDGParser, TextExtractor  # noqa: E402

__all__ = ["DDGParser", "ReachApiError", "ReachClient",
           "TextExtractor", "build_grounded_messages", "main"]

if __name__ == "__main__":
    sys.exit(main())
