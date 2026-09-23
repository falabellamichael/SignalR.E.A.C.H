'use strict';

const nets = new Map();
function netForAgent(id) { return nets.get(id) || null; }
function registerNet(id, net) { nets.set(id, net); }
function unregisterNet(id) { nets.delete(id); }

module.exports = { netForAgent, registerNet, unregisterNet };
