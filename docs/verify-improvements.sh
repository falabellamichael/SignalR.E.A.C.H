#!/usr/bin/env bash
# Re-verification script for docs/IMPROVEMENTS.md §1 Evidence lines.
# Run from repo root: bash docs/verify-improvements.sh
set -uo pipefail
cd "$(dirname "$0")/.."
check() { printf '%-46s' "$1"; shift; "$@" 2>&1 | head -3 || true; }
echo "=== Baseline metrics ==="
check 'main.mjs lines'        bash -c 'wc -l < studio/main.mjs'
check 'app.js lines'          bash -c 'wc -l < studio/renderer/app.js'
check 'ipcMain.handle count'  bash -c 'grep -c "ipcMain.handle" studio/main.mjs'
check 'preload invoke channels' bash -c 'grep -c ipcRenderer.invoke studio/preload.cjs'
check 'test files'            bash -c 'ls studio/test/*.test.cjs | wc -l'
check 'studio version'        node -p "require('./studio/package.json').version"
check 'release-please pkgs'   node -p "Object.keys(require('./release-please-config.json').packages)"
check 'dirty files'           bash -c 'git status --porcelain | wc -l'
echo "=== Phase 0 ==="
check '0.2 studio pkg in RP'  bash -c 'node -e "const p=require(\"./release-please-config.json\").packages; console.log(p.studio?\"studio-package-present\":\"MISSING\")"'
check '0.3 dist:win in CI'    bash -c 'grep -c "dist:win" .github/workflows/ci.yml || echo 0'
echo "=== Phase 1 ==="
check '1.1 test glob'         bash -c 'node -p "require(\"./studio/package.json\").scripts.test" | grep -c "test/\*\*" || echo 0'
check '1.2 eslint config'     bash -c 'ls eslint.config.* .eslintrc* 2>/dev/null || echo MISSING'
check '1.3 coverage script'   bash -c 'node -p "require(\"./studio/package.json\").scripts[\"test:coverage\"] || \"MISSING\""'
check '1.4 tracked dist/vsix' bash -c 'git ls-files | grep -E "dist/|\.vsix$|\.dmg$|__pycache__" | head -5 || echo none'
check '1.5 crash handlers'    bash -c 'grep -rc "uncaughtException" studio/main.mjs'
check '1.6 atomicWriteJson'   bash -c 'grep -rn "atomicWriteJson\|atomic-write" studio/ --include=*.cjs --include=*.mjs | head -4'
check '1.7 csp script-src'    bash -c 'grep -n "Content-Security-Policy" studio/renderer/index.html'
check '1.7 unsafe-inline in script-src' bash -c 'grep -n "script-src .*unsafe-inline" studio/renderer/index.html || echo none'
check '1.8 engines.node'      bash -c 'node -p "require(\"./studio/package.json\").engines.node"'
check '1.8 .nvmrc'            bash -c 'cat studio/.nvmrc 2>/dev/null || echo MISSING'
echo "=== Phase 2 ==="
check '2.1 safeStorage'       bash -c 'grep -rl "safeStorage" studio/ | head -5 || echo none'
check '2.2 shim token perms'  bash -c 'grep -n "chmod\|0o600\|0600" copilot/copilot_shim.py || echo none'
check '2.3 STUDIO_IPC.md'     bash -c 'test -f docs/STUDIO_IPC.md && wc -l < docs/STUDIO_IPC.md || echo MISSING'
check '2.4 audit rotation'    bash -c 'grep -n "rotate\|MAX_BYTES\|verify" studio/agent/audit-log.cjs | head -5 || echo none'
check '2.5 conversation cap'  bash -c 'grep -n "MAX_CONVERSATION\|history.jsonl\|MAX_SERIALIZED" studio/agent/agent-store.cjs | head -5 || echo none'
check '2.6 untrusted delim'   bash -c 'grep -rn "UNTRUSTED\|untrusted" studio/agent/context.cjs studio/agent/agent-loop.cjs 2>/dev/null | head -4 || echo none'
check '2.7 rate limit gate'   bash -c 'grep -n "RateLimit\|rateLimit\|requestsPerMinute" studio/agent/connections.cjs | head -5 || echo none'
echo "=== Phase 3-5 ==="
check '3.1 studio/ipc dir'    bash -c 'ls studio/ipc/*.cjs 2>/dev/null || echo MISSING'
check '3.3 ipc-manifest'      bash -c 'test -f studio/ipc-manifest.json && echo present || echo MISSING'
check '3.5 code-index owner'  bash -c 'grep -n "invalidateIndex\|TTL" studio/agent/code-index.cjs | head -3 || echo none'
check '4.1 per-conv store'    bash -c 'grep -n "agents/index.json\|agentsDir\|writeConversation" studio/agent/agent-store.cjs | head -4 || echo none'
check '4.2 team persistence'  bash -c 'grep -rn "teams/" studio/agent/team-runner.cjs | head -4 || echo none'
check '4.4 export/import'     bash -c 'test -f studio/test/export-import.test.cjs && echo test-present || echo MISSING'
check '4.5 approval notify'   bash -c 'grep -n "new Notification\|dock.setBadge" studio/main.mjs | head -4 || echo none'
check '4.6 budgets.jsonl'     bash -c 'grep -rn "budgets.jsonl" studio/ | head -3 || echo none'
check '5.3 schemaVersion'     bash -c 'grep -rn "schemaVersion" studio/agent/connections.cjs studio/main.mjs | head -4 || echo none'
check '5.4 browser history'   bash -c 'grep -rn "history" studio/browser/page.cjs | head -3 || echo none'
check '5.5 logLevel'          bash -c 'grep -rn "logLevel" studio/ | head -4 || echo none'
check '5.7 non-win telemetry' bash -c 'ls studio/agent/telemetry-* 2>/dev/null || echo MISSING'
echo "=== files present ==="
ls studio/ipc/ studio/.nvmrc studio/CHANGELOG.md eslint.config.mjs studio/ipc-manifest.json docs/STUDIO_IPC.md 2>&1 | head -20
