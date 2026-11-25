'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const currentNet = new AsyncLocalStorage();
const nets = new Map();
function netForAgent(id) {
  const scoped = currentNet.getStore();
  if (scoped) return scoped.agents.has(id) ? scoped : null;
  const registered = nets.get(id);
  // Roster ids are stable within a run, but can repeat across active runs.
  // Outside a driver's async scope, never guess which crew owns a tool call.
  return registered?.size === 1 ? registered.values().next().value : null;
}
function registerNet(id, net) {
  if (!nets.has(id)) nets.set(id, new Set());
  nets.get(id).add(net);
}
function unregisterNet(id, net) {
  const registered = nets.get(id);
  registered?.delete(net);
  if (!registered?.size) nets.delete(id);
}
function withNet(net, callback) { return currentNet.run(net, callback); }

module.exports = { netForAgent, registerNet, unregisterNet, withNet };
