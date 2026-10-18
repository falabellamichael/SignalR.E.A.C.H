# SignalREACH Windows suite

One offline Windows installer, with independent component checkboxes:

- Reach Studio
- SimpleREACH for Microsoft VS Code (stable)
- SignalREACH Public for SimpleRAG
- SignalREACH system tray

The final page offers independent launch checkboxes for the installed components.
All launch options default to off. VS Code and SimpleRAG extensions launch their
host application; those applications must already be installed. SimpleRAG needs
its Advanced page reloaded. The installer does not install either host.

## Build

On Windows with Node.js/npm and Python, install the dependencies in `studio`,
`vscode`, and `copilot/tray`, then run from the repository root:

```powershell
python installer/windows/build.py
```

The build packages current Studio/tray sources using their own NSIS installers,
with automatic launch disabled, packages the VS Code extension using VSCE, and
builds only the public SimpleRAG frontend. It then bundles these in a single NSIS
installer under `dist/windows-suite/`. `sha256.json` records hashes for every
bundled component and all public-extension files. The embedded and adjacent
`payload-manifest.json` records the public-extension version and payload hashes.
The builder extracts the finished EXE with 7-Zip and compares every payload file
before replacing the existing installer. A failed build leaves the prior EXE in place.
The suite filename follows the Studio version; the public extension has its own
version, recorded in `payload-manifest.json`.
The target machine needs neither Python nor Node.js. Windows PowerShell 5.1 is
used for installing the extensions. Build tools may download dependencies.

7-Zip must be installed on the build machine. `--sevenzip PATH` overrides its
location. `--makensis PATH` overrides the NSIS compiler found in electron-builder's cache.
`--skip-app-builds` reuses the suite's existing component installers for packaging
iteration; the payload manifest records when these binaries are reused. Omit it
when rebuilding the app components for a release. Remove old versioned component installers from
the suite build output before building a different version.

## Installation and maintenance

Run the suite installer as the intended Windows user. Choose components, inspect
installation details, and choose applications to launch. No component is launched
automatically. A failed component stops Setup and reports failure; already
installed components remain installed. Rerun Setup to retry or add components.
Unchecked components are not removed.

Studio and tray retain their existing app IDs, settings locations, and native
uninstallers in Windows Installed Apps. Remove the VS Code extension through
VS Code, and the public extension through SimpleRAG's extension manager.
The suite is a bootstrap installer, not a fifth installed application.

SimpleRAG installation respects `PYMU_RAG_EXTENSION_HOME` and `PYMU_RAG_HOME`,
otherwise using `%LOCALAPPDATA%/RAGWorkspace/extensions`. It validates the public
asset hashes and merges only `signal-reach-public` into the existing registry.
It never deploys the Admin edition or operator runtime. Existing extension
entries and user preferences are preserved.
If a newer public extension is already installed, Setup keeps it and continues
with the other selected components. Equal-version reinstall and upgrades remain
available. Version comparison includes numeric components and prerelease ordering.

This initial installer targets Windows x64. It does not install VS Code Insiders
or choose among multiple VS Code profiles. Release signing is supplied by the
normal electron-builder signing configuration; the outer installer also needs
signing before public distribution.

## Verification

`python installer/windows/test_public.py` exercises first install, reinstall,
preservation of unrelated extension registry entries and private state, numeric
and prerelease downgrade protection, and tampered-asset rejection
in a temporary extension home. The suite and both embedded app installers compile
successfully. A full native wizard walkthrough, including each component-selection
combination and launch action, still needs verification on a clean Windows machine.
