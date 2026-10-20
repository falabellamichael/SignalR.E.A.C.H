"""Build the offline, per-user Windows suite installer from current sources."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]


def run(args, cwd=ROOT):
    print('+', subprocess.list2cmdline([str(arg) for arg in args]), flush=True)
    subprocess.run([str(arg) for arg in args], cwd=cwd, check=True)


def file_hash(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def verify_finished_installer(installer, payload, hashes, extractor, extracted):
    run([extractor, 'x', '-y', f'-o{extracted}', installer])
    embedded = extracted / '$PLUGINSDIR'
    for relative, expected in hashes.items():
        actual = embedded / relative
        if not actual.is_file() or file_hash(actual) != expected:
            raise RuntimeError(f'Finished installer payload mismatch: {relative}')
    expected_manifest = json.loads((payload / 'public/manifest.json').read_bytes())
    actual_manifest = json.loads((embedded / 'public/manifest.json').read_bytes())
    if actual_manifest != expected_manifest:
        raise RuntimeError('Finished installer contains a different public extension.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--makensis', type=Path, help='Path to NSIS makensis.exe')
    parser.add_argument('--sevenzip', type=Path, help='Path to 7z.exe for verifying the finished installer')
    parser.add_argument('--skip-app-builds', action='store_true', help='Reuse previously built suite component installers')
    args = parser.parse_args()
    if os.name != 'nt':
        parser.error('Build on Windows.')
    extractor = args.sevenzip or shutil.which('7z.exe')
    if not extractor:
        extractor = Path(os.environ.get('ProgramFiles', 'C:/Program Files')) / '7-Zip/7z.exe'
    extractor = Path(extractor)
    if not extractor.is_file():
        parser.error('7-Zip is required to verify the finished installer. Supply --sevenzip.')
    run([sys.executable, ROOT / 'installer/windows/test_public.py'])
    run([sys.executable, ROOT / 'installer/windows/test_ide.py'])
    out = ROOT / 'dist' / 'windows-suite'
    out.mkdir(parents=True, exist_ok=True)
    npm, npx = shutil.which('npm.cmd'), shutil.which('npx.cmd')
    if not npm or not npx:
        parser.error('Node.js and npm are required to build the installer.')
    if not args.skip_app_builds:
        run([npm, 'run', 'check'], ROOT / 'studio')
        run([npm, 'run', 'build:editor'], ROOT / 'studio')
        for directory, target in [('studio', 'studio'), ('copilot/tray', 'tray')]:
            package = json.loads((ROOT / directory / 'package.json').read_text())
            run([npx, '--no-install', 'electron-builder', '--win', 'nsis', '--publish', 'never',
                 f"-c.electronVersion={package['devDependencies']['electron']}",
                 '-c.nsis.runAfterFinish=false', '-c.nsis.oneClick=false',
                 '-c.nsis.perMachine=false', f'-c.directories.output={out / target}'], ROOT / directory)
    compiler = args.makensis
    if not compiler:
        cache = Path(os.environ['LOCALAPPDATA']) / 'electron-builder' / 'Cache' / 'nsis'
        compiler = next((p for p in sorted(cache.glob('*/makensis.exe')) if (p.parent / 'Include' / 'MUI2.nsh').exists()), None)
    if not compiler or not compiler.is_file():
        parser.error('NSIS not found. Supply --makensis or build the app installers first.')
    version = json.loads((ROOT / 'studio/package.json').read_text())['version']
    output = out / f'SignalREACH Suite Setup {version}.exe'
    with tempfile.TemporaryDirectory(prefix='payload-', dir=out) as temporary:
        payload = Path(temporary)
        for component in ['studio', 'tray']:
            source = 'studio' if component == 'studio' else 'copilot/tray'
            component_version = json.loads((ROOT / source / 'package.json').read_text())['version']
            installers = list((out / component).glob(f'*Setup {component_version}.exe'))
            if len(installers) != 1:
                raise RuntimeError(f'Expected one installer in {out / component}, found {len(installers)}')
            shutil.copyfile(installers[0], payload / f'{component}-setup.exe')
        run([npx, '--yes', '@vscode/vsce@3.6.2', 'package', '--allow-missing-repository',
             '--out', payload / 'simplereach.vsix'], ROOT / 'vscode')
        spec = importlib.util.spec_from_file_location('editions', ROOT / 'tools/extension_editions.py')
        editions = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(editions)
        public, _ = editions.build(ROOT, 'public', payload / 'editions')
        shutil.copytree(public, payload / 'public')
        shutil.copyfile(ROOT / 'installer/windows/components.ps1', payload / 'components.ps1')
        manifest = json.loads((payload / 'public/manifest.json').read_text())
        if manifest['id'] != 'signal-reach-public' or manifest['edition'] != 'public':
            raise RuntimeError('Only the public SimpleRAG edition may be bundled.')
        public_files = ['manifest.json'] + [asset['path'] for asset in manifest['scripts'] + manifest['styles']]
        files = [p.relative_to(payload).as_posix() for p in payload.iterdir() if p.is_file()]
        files += ['public/' + name for name in public_files]
        hashes = {relative: file_hash(payload / relative) for relative in sorted(files)}
        metadata = {
            'schema_version': 1, 'suite_version': version,
            'public_extension': {'id': manifest['id'], 'version': manifest['version']},
            'reused_app_installers': args.skip_app_builds, 'files': dict(hashes),
        }
        metadata_path = payload / 'payload-manifest.json'
        metadata_path.write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf-8')
        hashes['payload-manifest.json'] = file_hash(metadata_path)
        candidate = payload / 'suite-setup.exe'
        run([compiler, f'/DPAYLOAD={payload}', f'/DOUTPUT={candidate}', ROOT / 'installer/windows/suite.nsi'])
        verify_finished_installer(candidate, payload, hashes, extractor, payload / 'verified')
        hashes[output.name] = file_hash(candidate)
        candidate.replace(output)
        shutil.copyfile(metadata_path, out / 'payload-manifest.json')
        (out / 'sha256.json').write_text(json.dumps(hashes, indent=2) + '\n')
    print(f'Built: {output}')


if __name__ == '__main__':
    main()
