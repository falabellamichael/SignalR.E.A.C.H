#!/usr/bin/env python3
"""SignalREACH frontend installer and explicit private runtime manager.

Frontend installation defaults to the public edition. Legacy operator runtime
installation is explicitly requested with ``install-runtime``. Runtime imports
must happen after dispatch: importing reach config migrates local operator data.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

def main(argv=None):
    arguments = list(sys.argv[1:] if argv is None else argv)
    if not arguments or arguments[0] in ("--help", "-h", "install", "build", "export"):
        from extension_editions import main as edition_main
        if not arguments or arguments[0] in ("--help", "-h"):
            print("Frontend installer: install [--edition public|admin].")
            print("Private full runtime installer: install-runtime [runtime options].")
            print("Other explicit runtime commands remain available for operator maintenance.")
            return edition_main(["--help"])
        return edition_main(arguments)

    if arguments[0] == "install-runtime":
        arguments[0] = "install"
    from reach.cli import main as runtime_main
    original = sys.argv
    try:
        sys.argv = [original[0]] + arguments
        return runtime_main()
    finally:
        sys.argv = original

if __name__ == "__main__":
    main()
