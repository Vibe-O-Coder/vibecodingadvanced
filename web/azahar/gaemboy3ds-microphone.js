const TARGET_RATE = 48000;

class GaemboyMicrophone extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const buffer = options.processorOptions.buffer;
    this.control = new Int32Array(buffer, 0, 3);
    this.samples = new Int16Array(buffer, 12);
    this.phase = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel || !Atomics.load(this.control, 2)) {
      this.phase = 0;
      return true;
    }
    let write = Atomics.load(this.control, 0) >>> 0;
    const read = Atomics.load(this.control, 1) >>> 0;
    for (const sample of channel) {
      while (this.phase < TARGET_RATE) {
        if (((write - read) >>> 0) < this.samples.length) {
          this.samples[write % this.samples.length] =
            Math.round(Math.max(-1, Math.min(1, sample)) * 32767);
          write = (write + 1) >>> 0;
        }
        this.phase += sampleRate;
      }
      this.phase -= TARGET_RATE;
    }
    Atomics.store(this.control, 0, write);
    return true;
  }
}

registerProcessor('gaemboy3ds-microphone', GaemboyMicrophone);
