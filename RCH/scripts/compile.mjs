import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function collectSources(includeTests) {
  const sources = {};
  async function add(name) {
    if (sources[name]) return;
    const allowed = name.startsWith('contracts/') || name.startsWith('@openzeppelin/contracts/');
    if (!allowed || name.includes('..')) throw new Error(`Unsupported source: ${name}`);
    const path = resolve(root, name.startsWith('@') ? `node_modules/${name}` : name);
    const content = await readFile(path, 'utf8');
    sources[name] = { content };
    for (const match of content.matchAll(/import\s+(?:[^;]*?\s+from\s+)?["']([^"']+)["']\s*;/g)) {
      const imported = match[1].startsWith('.') ? posix.normalize(posix.join(posix.dirname(name), match[1])) : match[1];
      await add(imported);
    }
  }
  async function scan(dir) {
    for (const entry of (await readdir(resolve(root, dir), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!includeTests && entry.name === 'test') continue;
      const name = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await scan(name);
      else if (entry.name.endsWith('.sol')) await add(name);
    }
  }
  await scan('contracts');
  return Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b)));
}

export async function compile({ includeTests = false } = {}) {
  const input = {
    language: 'Solidity',
    sources: await collectSources(includeTests),
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'shanghai',
      metadata: { useLiteralContent: true },
      outputSelection: { '*': { '*': ['abi', 'metadata', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter((item) => item.severity === 'error');
  if (errors.length) throw new Error(errors.map((item) => item.formattedMessage).join('\n'));
  const warnings = (output.errors || []).map((item) => item.formattedMessage);
  const artifacts = {};
  for (const [sourceName, units] of Object.entries(output.contracts)) {
    if (!sourceName.startsWith('contracts/')) continue;
    for (const [contractName, artifact] of Object.entries(units)) {
      if (!artifact.evm.bytecode.object) continue;
      const runtimeBytes = artifact.evm.deployedBytecode.object.length / 2;
      if (runtimeBytes > 24576 || artifact.evm.bytecode.object.length / 2 > 49152) {
        throw new Error(`${contractName} exceeds Ethereum deployment size limits.`);
      }
      artifacts[contractName] = {
        contractName, sourceName, abi: artifact.abi,
        bytecode: `0x${artifact.evm.bytecode.object}`,
        deployedBytecode: `0x${artifact.evm.deployedBytecode.object}`,
        immutableReferences: artifact.evm.deployedBytecode.immutableReferences,
        metadata: artifact.metadata,
      };
    }
  }
  return { artifacts, compiler: solc.version(), input, sourceHash: sha256(JSON.stringify(input)), warnings };
}

export async function writeBuild(build) {
  const dir = resolve(root, 'artifacts');
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, 'build-info.json'), `${JSON.stringify(build, null, 2)}\n`);
  for (const [name, artifact] of Object.entries(build.artifacts)) {
    await writeFile(resolve(dir, `${name}.json`), `${JSON.stringify(artifact, null, 2)}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const build = await compile();
  await writeBuild(build);
  for (const warning of build.warnings) process.stderr.write(warning);
  process.stdout.write(`Compiled ${Object.keys(build.artifacts).length} production contracts with ${build.compiler}.\nSource hash: ${build.sourceHash}\n`);
}
