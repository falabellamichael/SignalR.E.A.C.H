'use strict';

const { TeamNurse } = require('./team-nurse.cjs');

module.exports = ({ cleanOutput, linksCompleteIn }) => ({
  _asLinksResult(result) {
    if (this.team.mode !== 'links' || !result || result.ok) return result;
    if (['waiting_input', 'waiting_edits', 'stopped'].includes(result.status)) return result;
    return { ...result, status: 'stalled' };
  },

  /* ---------- LINKS mode: the peer network ---------- */

  _operatorHelpers(status) {
    if (!this.net) return [];
    return [...this.net.agents.values()].filter(rec =>
      rec.origin === 'spawned'
      && rec.operatorAdded === true
      && (!status || rec.status === status));
  },

  _activeOperatorHelperCount() {
    const terminal = new Set(['completed', 'failed', 'stopped', 'abandoned', 'stalled', 'skipped']);
    return this._operatorHelpers().filter(rec =>
      !terminal.has(rec.status) && this.net.activeTasks.has(rec.id)).length;
  },

  _cancelQueuedOperatorAgents(reason) {
    if (!this.net?.cancelQueuedSpawned) return 0;
    let cancelled = 0;
    for (const rec of this._operatorHelpers('queued')) {
      if (this.net.cancelQueuedSpawned(rec.id, reason)) cancelled++;
    }
    return cancelled;
  },

  /* A completion declaration is terminal for the whole peer network, but an
   * immediate abort can cut off a peer between a successful tool result and
   * its final response. Give active peers one short grace window, then abort
   * anything still hanging (including endpoints that never send headers).
   * This is not a user Stop and is reported as successful team completion. */
  _concludeLinkPeers(declarerKey, declarerName, { includeDeclarer = false } = {}) {
    // Completion is terminal for operator admission too. Do not accept mail or
    // launch paid helper work during the short grace used only to harvest
    // already-running peers.
    this.acceptingRuntimeAgents = false;
    this._cancelQueuedOperatorAgents('Links completed before this helper started.');
    if (this._linksConclusionTimer) return;
    this._linksConclusionTimer = setTimeout(() => {
      this._linksConclusionTimer = null;
      for (const [key, loop] of this.loops) {
        if ((!includeDeclarer && key === declarerKey) || !loop.running) continue;
        this._linksSuperseded.set(key, declarerName);
        loop.stop();
      }
    }, this.links.graceMs);
  },

  /* Completion declared? By a member in its own answer (this._linkDeclared)
   * or in a message to a peer (net.linksComplete set on send). */
  _linksDone() {
    return this._linkDeclared || (this.net ? this.net.linksComplete : null);
  },

  async _linksRun() {
    const n = this.personas.length;
    const budget = this.links.rate * Math.max(1, n - 1);
    const results = new Array(n);
    const turns = new Array(n).fill(0);
    // A failed turn stalls the member. Peers carry on, but an explicit message
    // to that member is a bounded recovery signal: the next Links round wakes
    // it with the new instruction instead of silently leaving mail undelivered.
    const stalled = new Map();
    const nurse = new TeamNurse({
      personas: this.personas,
      team: this.team,
      net: this.net,
      enabled: this.team.nurse !== false,
      policy: this.team.nursePolicy || null,
      emit: (_type, payload) => this._emit('nurse', { ...payload, nurseType: payload.action, silent: true }),
    });
    this.nurse = nurse;
    const noteStall = (index, error) => {
      stalled.set(index, error || 'member stalled');
      this.net?.syncMember(`m${index}-${this.personas[index].id}`, { status: 'stalled', error: stalled.get(index) });
      this._emit('links-stall', { index, name: this.personas[index].name, error: stalled.get(index) });
    };

    /* One event-driven pool owns both initial turns and Links wake-ups. The old
     * pair of mapWithConcurrency barriers left fast, recoverable members idle
     * behind one unrelated provider timeout. Here every settlement immediately
     * pulses the Nurse and refills any free slot, while the same concurrency,
     * message, round, and per-member turn caps remain in force. */
    const maxTurns = this.links.memberTurns + 1;
    const jobQueue = this.personas.map((_, index) => ({ kind: 'initial', index, generation: 0 }));
    const activeJobs = new Map();
    const memberBusy = new Set();
    const queuedWake = new Set();
    const operatorWakes = new Set();
    const memberGeneration = new Array(n).fill(0);
    let nextJobId = 0;
    let rounds = 0;
    let seenActivityVersion = this._linksActivityVersion;
    // Alternate helper and roster admission when both are queued. This lets a
    // newly-added specialist join promptly without starving the fixed roster.
    let preferOperatorHelper = true;

    const failedJobResult = (index, error) => ({
      index,
      name: this.personas[index].name,
      model: this._memberConn(index).model,
      ok: false,
      output: '',
      status: this.stopped ? 'stopped' : 'stalled',
      error: error?.message || String(error || 'Links member job failed.'),
      completedAt: Date.now(),
    });

    const queueReadyWakes = (triggerGeneration = 0) => {
      if (this.stopped || this._linksDone()) return 0;
      const queued = [];
      for (let index = 0; index < n; index++) {
        // A pending roster member consumes its mail in the initial prompt. A
        // busy or already-queued member keeps accumulating mail for one bounded
        // coalesced follow-up rather than starting a concurrent turn.
        if (!turns[index] || turns[index] >= maxTurns || memberBusy.has(index) || queuedWake.has(index)) continue;
        const rec = this.net?.agents.get(`m${index}-${this.personas[index].id}`);
        if (!rec?.inbox?.length) continue;
        const generation = Math.max(memberGeneration[index] + 1, triggerGeneration + 1);
        if (generation > this.links.maxRounds) continue; // preserve over-cap mail for status/diagnostics
        const job = { kind: 'wake', index, generation };
        jobQueue.push(job);
        queuedWake.add(index);
        queued.push(job);
      }
      if (queued.length) rounds = Math.max(rounds, ...queued.map(job => job.generation));
      return queued.length;
    };

    const launchJob = (job) => {
      const { index } = job;
      if (this.stopped || this._linksDone() || memberBusy.has(index)) return false;

      let box = [];
      let nurseWake = false;
      let reviving = false;
      if (job.kind === 'initial') {
        if (turns[index]) return false;
        turns[index] = 1;
      } else {
        queuedWake.delete(index);
        operatorWakes.delete(index);
        if (!turns[index] || turns[index] >= maxTurns || job.generation > this.links.maxRounds) return false;
        // Drain only when the slot is actually reserved. Until this point the
        // inbox stays visible to the Nurse, coalesces new mail, and survives a
        // Stop/completion without any restoration bookkeeping.
        box = this._takeLinkInbox(index);
        if (!box.length) return false;
        nurseWake = box.some(message => String(message).startsWith('TEAM NURSE RECOVERY'));
        reviving = stalled.has(index);
        this._emit('links-round', {
          round: job.generation,
          waking: [this.personas[index].name],
          nurseWaking: nurseWake ? [this.personas[index].name] : [],
          silent: nurseWake,
          exchanges: this.net ? this.net.linkSends : 0,
          budget,
        });
        if (reviving) {
          stalled.delete(index);
          this._emit('links-revive', { index, name: this.personas[index].name, messages: box.length, source: nurseWake ? 'nurse' : 'peer', silent: nurseWake });
        }
        if (nurseWake) nurse.recordWakeStarted(index);
        turns[index]++;
      }

      memberBusy.add(index);
      memberGeneration[index] = Math.max(memberGeneration[index], job.generation);
      const jobId = ++nextJobId;
      job.nurse = nurseWake;
      const running = (async () => {
        if (job.kind === 'initial') {
          return this._runMember(this.personas[index], index, this._memberPrompt(index, 'links', []), { keep: true });
        }
        const result = await this._wakeMember(index, box);
        if (result?.wakeDeferred) this._restoreLinkInbox(index, box);
        return result;
      })();
      const tracked = Promise.resolve(running)
        .then(result => ({ type: 'settled', jobId, job, result }))
        .catch(error => ({ type: 'settled', jobId, job, result: failedJobResult(index, error) }));
      activeJobs.set(jobId, tracked);
      return true;
    };

    const pump = () => {
      let launched = 0;
      while (!this.stopped && !this.userPaused && this.acceptingRuntimeAgents && !this._linksDone()
        && activeJobs.size + this._activeOperatorHelperCount() < this.concurrency) {
        const queuedHelper = this._operatorHelpers('queued')[0] || null;
        const tryHelper = queuedHelper && (preferOperatorHelper || !jobQueue.length);
        if (tryHelper) {
          const started = this.net.startSpawned(queuedHelper.id);
          if (!started.ok) break;
          preferOperatorHelper = false;
          launched++;
          continue;
        }
        if (jobQueue.length) {
          if (launchJob(jobQueue.shift())) {
            preferOperatorHelper = true;
            launched++;
          }
          continue;
        }
        if (queuedHelper) {
          const started = this.net.startSpawned(queuedHelper.id);
          if (!started.ok) break;
          preferOperatorHelper = false;
          launched++;
          continue;
        }
        break;
      }
      return launched;
    };
    this._linksPump = pump;
    this._requestLinksWake = index => {
      if (!this.running || this.stopped || !this.acceptingRuntimeAgents || this._linksDone()) {
        throw new Error('The team run is finalizing. Start a new team run to retry this member.');
      }
      if (this.userPaused) throw new Error('Start the team before waking this stalled member.');
      if (turns[index] >= maxTurns || memberGeneration[index] >= this.links.maxRounds) {
        throw new Error('This member reached its recovery limit. Start a new team run to retry it.');
      }
      // Coalesce repeated clicks and existing recovery mail into one scheduled
      // turn. Never run a second loop outside the team's concurrency pool.
      if (operatorWakes.has(index) || queuedWake.has(index)) return;
      operatorWakes.add(index);
      const result = this.messageMember(`m${index}-${this.personas[index].id}`,
        'The user pressed Start to wake you after a stall. Resume your original task using your saved context. Take a concrete next action, or explain any blocker that still needs user input.');
      if (!result.ok) { operatorWakes.delete(index); throw new Error(result.error); }
      this._emit('member-wake-queued', { index, name: this.personas[index].name });
    };

    const settleJob = ({ jobId, job, result }) => {
      activeJobs.delete(jobId);
      memberBusy.delete(job.index);
      results[job.index] = result || failedJobResult(job.index, 'Member returned no result.');
      memberGeneration[job.index] = Math.max(memberGeneration[job.index], job.generation);
      if (job.nurse) nurse.recordWakeResult(job.index, results[job.index]);
      if (results[job.index]?.status === 'stalled') noteStall(job.index, results[job.index].error);
      else stalled.delete(job.index);
    };

    const pulse = (triggerGeneration = 0) => {
      if (this.stopped || this._linksDone()) return;
      nurse.stageRecoveries({ results, stalled, turns, maxTurns });
      queueReadyWakes(triggerGeneration);
      pump();
    };

    pump();
    for (;;) {
      if (this.stopped || this._linksDone()) {
        // Existing Stop/conclusion-grace handling unwinds running loops. Never
        // launch queued work after the terminal signal, but do harvest anything
        // that was already in flight so result state remains truthful.
        if (!activeJobs.size) break;
        settleJob(await Promise.race(activeJobs.values()));
        continue;
      }

      pulse(0);
      if (activeJobs.size) {
        const activityWait = this._waitForLinksActivity(seenActivityVersion)
          .then(({ version, activity }) => ({ type: 'activity', version, activity }));
        const event = await Promise.race([...activeJobs.values(), activityWait]);
        if (event.type === 'activity') {
          seenActivityVersion = Math.max(seenActivityVersion, event.version);
          const senderIndex = event.activity?.from
            ? this.personas.findIndex((persona, index) => `m${index}-${persona.id}` === event.activity.from)
            : -1;
          pulse(senderIndex >= 0 ? memberGeneration[senderIndex] : 0);
          continue;
        }
        settleJob(event);
        pulse(event.job.generation);
        continue;
      }

      // `pump` can discard a stale queued job (for example, an inbox consumed
      // by its initial turn). Re-scan before declaring the roster quiescent.
      pulse(0);
      if (activeJobs.size || jobQueue.length) {
        pump();
        if (activeJobs.size) continue;
      }

      // A roster member may have delegated useful work and finished before its
      // worker. Await already-paid work (event-driven, no polling); its mail or
      // completed output is then considered before paying for synthesis.
      if (this.net) await this.net.drainActiveSpawned();
      if (!this.stopped && !this._linksDone()) {
        // A very fast helper can settle between drainActiveSpawned's final
        // scan and this continuation. Its onSettled hook may already have
        // launched a roster job, so always re-pump and inspect the whole pool
        // before declaring Links quiescent.
        pulse(0);
        if (activeJobs.size || jobQueue.length
          || this._activeOperatorHelperCount()
          || this._operatorHelpers('queued').length) continue;
      }
      break;
    }

    // Completion/Stop may deliberately leave not-yet-started initial jobs.
    // Keep the result array dense so final event serialization cannot trip on
    // sparse entries, and keep the network roster consistent for diagnostics.
    for (let index = 0; index < n; index++) {
      if (results[index]) continue;
      const result = {
        index,
        name: this.personas[index].name,
        model: this._memberConn(index).model,
        ok: false,
        output: '',
        status: this.stopped ? 'stopped' : 'skipped',
        error: this.stopped ? 'Stopped by you.' : 'Links completed before this member started.',
        completedAt: Date.now(),
      };
      results[index] = result;
      this.net?.syncMember(`m${index}-${this.personas[index].id}`, { status: result.status, error: result.error, output: '' });
    }
    this._linksActivityDeferred = null;

    // The roster is quiescent. Do not accept an operator helper after this
    // boundary: Links may now synthesize/finalize and cannot safely enroll new
    // work in the answer it is already constructing.
    this.acceptingRuntimeAgents = false;
    this._linksPump = null;
    this._requestLinksWake = null;
    this._cancelQueuedOperatorAgents('Links finalized before this helper started.');

    // Synthesis reuses (and then replaces) a roster result. Retain every
    // usable pre-synthesis answer so a failed synthesis cannot erase it.
    const preSynthesisOkResults = results.filter(result => result?.ok && result.output);
    let synthesized = null;
    let synthIndex = -1;
    if (!this.stopped && !this._linksDone()) {
      synthIndex = this._synthesisIndex();
      const viable = [...Array(n).keys()].filter(i => results[i]?.ok && results[i]?.status === 'completed' && !stalled.has(i));
      if (!viable.includes(synthIndex)) {
        const coordinator = viable.find(i => (this.team.members[i] || {}).roleId === 'coordinator');
        synthIndex = coordinator ?? (viable.length ? viable[viable.length - 1] : -1);
      }
      if (synthIndex >= 0) {
        const note = (this.net && this.net.linkSends >= budget)
          ? 'The crew has spent its full Links exchange budget (3× the chain rate).'
          : 'The crew has gone quiet without a completion declaration.';
        const stallNote = stalled.size
          ? ` Note: ${[...stalled.keys()].map(i => this.personas[i].name).join(', ')} stalled and produced no usable work — cover that gap or state it as missing.`
          : '';
        const workerResults = this.net
          ? this.net.snapshot().filter(worker => worker.origin === 'spawned')
          : [];
        const pendingMail = this.net
          ? this.personas.map((persona, index) => {
              const rec = this.net.agents.get(`m${index}-${persona.id}`);
              return rec?.inbox?.length ? { name: persona.name, messages: rec.inbox.slice() } : null;
            }).filter(Boolean)
          : [];
        const verifiedEvidence = (this.journal?.evidence() || []).slice(-20).map(item =>
          `${item.agentId}: ${item.tool} ${item.ok ? 'ok' : 'failed'}${item.path ? ` ${item.path}` : ''} [result ${item.resultSha256.slice(0, 12)}]`).join('\n').slice(0, 4000);
        const handoff = nurse.synthesisHandoff(results, stalled, workerResults, pendingMail)
          + (verifiedEvidence ? `\n\nVERIFIED TOOL EVIDENCE (journaled, not inferred):\n${verifiedEvidence}` : '');
        synthesized = await this._wakeMember(synthIndex, [], { synthesize: true, note: note + stallNote, handoff });
        results[synthIndex] = synthesized;
        this._emit('links-synthesis', { index: synthIndex, name: this.personas[synthIndex].name, budgetSpent: this.net ? this.net.linkSends : 0, nurseHandoffs: nurse.meta().handoffs });
      }
    }

    const done = this._linksDone();
    const declarerResult = results.find(r => r && r.ok && linksCompleteIn(r.output));
    const declarationMessage = done?.message ? cleanOutput(done.message) : '';
    const okResults = results.filter(r => r && r.ok);
    const fallbackResults = synthesized && !synthesized.ok ? preSynthesisOkResults : okResults;
    this._linksAnswer = (declarerResult && declarerResult.output)
      || declarationMessage
      || (synthesized && synthesized.ok && synthesized.output)
      || (fallbackResults.length
        ? fallbackResults.map(r => `【${r.name}】\n${r.output}`).join('\n\n')
        : results.filter(Boolean).map(r => `【${r.name}】\n(failed: ${r.error || 'unknown'})`).join('\n\n'));
    this._linksMeta = {
      rounds,
      budget,
      exchanges: this.net ? this.net.linkSends : 0,
      completedBy: done && done.by ? done.by : (synthesized?.ok && synthIndex >= 0 ? this.personas[synthIndex].name : null),
      synthesized: !!synthesized?.ok,
      synthesisAttempted: !!synthesized,
      stalled: stalled.size,
      nurse: nurse.meta(),
    };
    return results;
  },
});
