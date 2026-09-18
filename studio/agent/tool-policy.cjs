'use strict';

// Shared by the prompt and executor. A hidden tool is also blocked at dispatch.
// sandbox.cjs only requires node:path, so importing it here cannot create a
// require cycle (tool-registry -> tool-policy -> sandbox).
const { validatePolicy: validateSandboxPolicy } = require('./sandbox.cjs');

const defaults = { agent: true, workspace: true, think: true, web: true, terminal: true };
function features(settings = {}) { return { ...defaults, ...settings.features }; }
function disabledTools(settings = {}, tools = {}) {
  const f = features(settings), disabled = new Set(settings.disabledTools || []);
  for (const [name, tool] of Object.entries(tools)) {
    if (!f.agent || !f.terminal && tool.class === 'exec'
      || !f.web && (tool.class === 'browse' || tool.tier === 'browser')
      || !f.workspace && (['read', 'write', 'edit_patch', 'glob', 'search', 'list', 'shell'].includes(name) || tool.tier === 'reach')) disabled.add(name);
  }
  return [...disabled];
}
function validatePolicy(settings, tools) {
  if (settings.features !== undefined) {
    if (!settings.features || typeof settings.features !== 'object' || Array.isArray(settings.features)) throw new Error('Invalid tool controls.');
    for (const [key, value] of Object.entries(settings.features)) if (!(key in defaults) || typeof value !== 'boolean') throw new Error('Invalid tool control: ' + key);
  }
  if (settings.disabledTools !== undefined && (!Array.isArray(settings.disabledTools) || settings.disabledTools.some(name => !Object.hasOwn(tools, name)))) throw new Error('Unknown disabled tool.');
  if (settings.approvals !== undefined && !['prompt', 'auto-read', 'auto-all'].includes(settings.approvals)) throw new Error('Invalid approval mode.');
  if (settings.reviewEdits !== undefined && typeof settings.reviewEdits !== 'boolean') throw new Error('Invalid edit review setting.');
  if (settings.sandbox !== undefined) validateSandboxSettings(settings.sandbox);
  return settings;
}

/**
 * Validate the command-sandbox block at SAVE time.
 *
 * Without this, a malformed policy only surfaces when a command is executed —
 * and there it fails closed, refusing every command with "policy rejected".
 * That reads like a broken sandbox instead of a typo, so catch it here where the
 * user is still editing the setting.
 */
function validateSandboxSettings(sandbox) {
  if (!sandbox || typeof sandbox !== 'object' || Array.isArray(sandbox)) throw new Error('Sandbox settings must be an object.');
  if (sandbox.enabled !== undefined && typeof sandbox.enabled !== 'boolean') throw new Error('Sandbox "enabled" must be true or false.');
  if (sandbox.policy === undefined || sandbox.policy === null) return;
  try {
    validateSandboxPolicy(sandbox.policy);
  } catch (error) {
    throw new Error('Invalid sandbox policy: ' + error.message);
  }
}

module.exports = { defaults, features, disabledTools, validatePolicy, validateSandboxSettings };
