'use strict';

// A user stop releases the active request but retains the driver's stack,
// transcript, pending reviews, and chain position until Start is pressed.
class RunControl {
  constructor(loop = null, onChange = () => {}) {
    this.loop = loop;
    this.onChange = onChange;
    this.paused = false;
    this.finished = false;
    this.interrupted = false;
  }
  pause() {
    if (this.finished || this.paused) return;
    this.paused = true;
    this.gate = new Promise(resolve => { this.release = resolve; });
    if (this.loop?.running) {
      this.interrupted = true;
      this.loop.stop();
    }
    this.onChange(true);
  }
  resume() {
    if (!this.paused || this.finished) return;
    this.paused = false;
    this.release?.();
    this.onChange(false);
  }
  async wait(stopSignal) {
    while (this.paused) {
      const stopped = await Promise.race([this.gate.then(() => false), stopSignal().then(() => true)]);
      if (stopped) return;
    }
  }
}

module.exports = { RunControl };
