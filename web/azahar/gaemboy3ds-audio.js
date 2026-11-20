// Plays the emulator's audio ring (stereo s16 at the 3DS DSP rate, in shared wasm memory) and
// resamples it linearly to the AudioContext rate. Underruns output silence; excess latency is
// trimmed so audio stays close to the picture.
const OFF_WRITE = 348;
const OFF_READ = 352;

class Gaemboy3DSAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ready = false;
    this.muted = false;
    this.pos = 0;
    this.underruns = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'init') {
        this.i32 = new Int32Array(data.buffer);
        this.i16 = new Int16Array(data.buffer);
        this.base = data.state;
        this.ringPtr = data.ringPtr;
        this.ringFrames = data.ringFrames;
        this.step = data.srcRate / sampleRate;
        this.ready = true;
      } else if (data.type === 'mute') {
        this.muted = data.muted;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const left = out[0];
    const right = out[1] || out[0];
    if (!this.ready) return true;
    const writeIdx = (this.base + OFF_WRITE) >> 2;
    const readIdx = (this.base + OFF_READ) >> 2;
    const write = Atomics.load(this.i32, writeIdx) >>> 0;
    let read = Atomics.load(this.i32, readIdx) >>> 0;
    let avail = (write - read) >>> 0;
    // Keep latency under ~150 ms: skip ahead if the producer ran far in front.
    const maxLag = Math.floor(0.15 * sampleRate * this.step);
    if (avail > maxLag) {
      read = (read + (avail - maxLag)) >>> 0;
      avail = maxLag;
      this.pos = 0;
    }
    const ring = this.ringPtr >> 1;
    const frames = this.ringFrames;
    for (let i = 0; i < left.length; i++) {
      const idx = Math.floor(this.pos);
      if (idx + 1 >= avail) {
        left[i] = 0;
        right[i] = 0;
        this.underruns++;
        continue;
      }
      const frac = this.pos - idx;
      const a = ring + (((read + idx) % frames) * 2);
      const b = ring + (((read + idx + 1) % frames) * 2);
      const l = this.i16[a] + (this.i16[b] - this.i16[a]) * frac;
      const r = this.i16[a + 1] + (this.i16[b + 1] - this.i16[a + 1]) * frac;
      left[i] = this.muted ? 0 : l / 32768;
      right[i] = this.muted ? 0 : r / 32768;
      this.pos += this.step;
    }
    const consumed = Math.min(Math.floor(this.pos), avail);
    this.pos -= consumed;
    Atomics.store(this.i32, readIdx, (read + consumed) | 0);
    return true;
  }
}

registerProcessor('gaemboy3ds-audio', Gaemboy3DSAudio);
