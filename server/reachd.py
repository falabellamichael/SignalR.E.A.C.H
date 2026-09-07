#!/usr/bin/env python3
"""SignalR.E.A.C.H relay daemon — launcher shim (v3.2.0).

All implementation lives in the ``reachd`` package next to this file.
This shim exists so the documented entry point ``python server/reachd.py``
(and the installers that call it) keep working unchanged.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from reachd.__main__ import main

if __name__ == "__main__":
    main()
