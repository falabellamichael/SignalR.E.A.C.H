'use strict';
const path = require('node:path');
const fs = require('node:fs');
const packaged = process.resourcesPath && path.join(process.resourcesPath, 'jev-policy.cjs');
module.exports = require(packaged && fs.existsSync(packaged) ? packaged : path.join(__dirname, '../../vscode/jev-policy.js'));
