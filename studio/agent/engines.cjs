'use strict';
const path = require('node:path');
const fs = require('node:fs');
const packaged = process.resourcesPath && path.join(process.resourcesPath, 'engine-core.cjs');
module.exports = require(packaged && fs.existsSync(packaged) ? packaged : path.join(__dirname, '../../vscode/engine-core.js'));
