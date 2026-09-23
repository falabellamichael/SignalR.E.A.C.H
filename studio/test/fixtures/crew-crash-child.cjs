'use strict';

const { TeamRunner } = require('../../agent/team-runner.cjs');
const { CrewJournal } = require('../../agent/crew-journal.cjs');

const [endpoint, file] = process.argv.slice(2);
const journal = new CrewJournal(file);
let runner;
runner = new TeamRunner({
  team: { id: 'crash-fixture', name: 'Crash fixture', mode: 'chain', members: [] },
  personas: [{ id: 'a', name: 'A', model: 'a' }, { id: 'b', name: 'B', model: 'b' }],
  task: 'Complete both parts.', endpoint, projectDir: process.cwd(), journal,
  requestTimeoutMs: 60000,
  sendEvent: (_channel, event) => {
    if (event.type === 'member-done' && event.index === 0) {
      runner.net.send({ from: 'm0-a', to: 'm1-b', message: 'First result is ready.' });
    }
  },
});
runner.run('teamrun-crash-fixture').catch(error => { process.stderr.write(error.stack || String(error)); process.exitCode = 1; });
