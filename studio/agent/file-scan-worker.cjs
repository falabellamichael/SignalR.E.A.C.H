'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { TOOLS } = require('./tool-registry.cjs');

(async () => {
  const { action, args, projectDir } = workerData;
  if (!['list', 'glob', 'search'].includes(action)) throw new Error('Unsupported file scan.');
  const result = await TOOLS[action].execute(args, { projectDir, inScanWorker: true });
  parentPort.postMessage({ result });
})().catch(error => parentPort.postMessage({ error: error.message }));
