// SPDX-License-Identifier: GPL-2.0-or-later
"use strict";

const PCM_RATE = 44100;
const RECORD_LIMIT = 96 * 1024 * 1024;

// Shared between the worklet and the fallback used on plain HTTP origins.
// Fila circular em quadros estéreo. Cópias em bloco evitam centenas de
// operações de módulo por chamada, especialmente com a emulação acelerada.
class StereoQueue {
  constructor(capacity) {
    this.capacity = Math.max(1, Math.ceil(capacity));
    this.data = new Float32Array(this.capacity * 2);
    this.cursor = 0;
    this.count = 0;
  }

  clear() {
    this.cursor = 0;
    this.count = 0;
  }

  push(pcm) {
    let frames = pcm.length >> 1;
    if (!frames) return;
    let source = 0;
    // Áudio antigo nunca deve atrasar o jogo: descarte primeiro as amostras
    // mais velhas e mantenha os últimos 200 ms para reprodução em tempo real.
    if (frames >= this.capacity) {
      source = (frames - this.capacity) * 2;
      frames = this.capacity;
      this.clear();
    } else if (this.count + frames > this.capacity) {
      const drop = this.count + frames - this.capacity;
      this.cursor = (this.cursor + drop) % this.capacity;
      this.count -= drop;
    }
    const write = (this.cursor + this.count) % this.capacity;
    const first = Math.min(frames, this.capacity - write);
    this.data.set(pcm.subarray(source, source + first * 2), write * 2);
    if (first < frames) {
      this.data.set(pcm.subarray(source + first * 2, source + frames * 2), 0);
    }
    this.count += frames;
  }

  play(left, right) {
    const frames = Math.min(left.length, this.count);
    let at = 0;
    let cursor = this.cursor;
    while (at < frames) {
      const block = Math.min(frames - at, this.capacity - cursor);
      let sample = cursor * 2;
      for (let i = 0; i < block; i++) {
        left[at] = this.data[sample++];
        right[at] = this.data[sample++];
        at++;
      }
      cursor = 0;
    }
    this.cursor = (this.cursor + frames) % this.capacity;
    this.count -= frames;
    if (frames < left.length) {
      left.fill(0, frames);
      right.fill(0, frames);
    }
  }
}

class EmulatorAudio {
  constructor() {
    this.context = null;
    this.node = null;
    this.queue = null;
    this.gain = null;
    this.outputStream = null;
    this.initializing = null;
    this.volume = .65;
    this.muted = false;
    this.recording = null;
    this.offset = 0;
  }

  async unlock() {
    if (!this.initializing) this.initializing = this.create().catch(() => {});
    if (this.context?.state === "suspended") await this.context.resume().catch(() => {});
    return this.initializing;
  }

  async create() {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return;
    try {
      this.context = new Context({ sampleRate: PCM_RATE, latencyHint: "interactive" });
    } catch {
      try { this.context = new Context(); } catch { return; }
    }
    const context = this.context;
    if (context.state === "suspended") context.resume().catch(() => {});
    this.gain = context.createGain();
    this.gain.connect(context.destination);
    if (context.createMediaStreamDestination) {
      this.outputStream = context.createMediaStreamDestination();
      this.gain.connect(this.outputStream);
    }
    this.setVolume(this.volume, this.muted);
    if (context.audioWorklet && location.protocol !== "file:") {
      const code = StereoQueue.toString() + "\n" +
        "class VBAPCM extends AudioWorkletProcessor {\n" +
        "  constructor() {\n" +
        "    super();\n" +
        "    this.queue = new StereoQueue(Math.ceil(sampleRate * .20));\n" +
        "    this.port.onmessage = ({data}) => data ? this.queue.push(data) : this.queue.clear();\n" +
        "  }\n" +
        "  process(_, outputs) {\n" +
        "    const out = outputs[0];\n" +
        "    if (out.length === 2) this.queue.play(out[0], out[1]);\n" +
        "    return true;\n" +
        "  }\n" +
        "}\nregisterProcessor('vba-pcm', VBAPCM);";
      const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      try {
        await context.audioWorklet.addModule(url);
        this.node = new AudioWorkletNode(context, "vba-pcm", {
          numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2]
        });
      } catch {
        this.node = null;
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    if (!this.node && context.createScriptProcessor) {
      this.queue = new StereoQueue(Math.ceil(context.sampleRate * .20));
      this.node = context.createScriptProcessor(1024, 0, 2);
      this.node.onaudioprocess = ({ outputBuffer }) => this.queue.play(
        outputBuffer.getChannelData(0), outputBuffer.getChannelData(1)
      );
    }
    if (this.node) this.node.connect(this.gain);
  }

  setVolume(value, muted) {
    this.volume = value;
    this.muted = muted;
    if (this.gain) this.gain.gain.setTargetAtTime(muted ? 0 : value, this.context.currentTime, .012);
  }

  clear() {
    this.queue?.clear();
    this.node?.port?.postMessage(null);
    this.offset = 0;
  }

  push(pcm, speed, silenced, sourceRate = PCM_RATE) {
    const frames = pcm.length >> 1;
    if (!frames) return;
    if (this.recording) {
      if (this.recording.size + pcm.byteLength <= RECORD_LIMIT) {
        this.recording.parts.push(pcm.slice());
        this.recording.size += pcm.byteLength;
      } else {
        this.recording.full = true;
      }
    }
    if (!this.node || silenced || this.context.state !== "running") return;
    const step = sourceRate * speed / this.context.sampleRate;
    const output = new Float32Array(Math.ceil(frames / step) * 2);
    let read = this.offset;
    let pos = 0;
    for (; read < frames; read += step) {
      const index = Math.floor(read) * 2;
      const next = Math.min(index + 2, (frames - 1) * 2);
      const t = read % 1;
      output[pos++] = (pcm[index] * (1 - t) + pcm[next] * t) / 32768;
      output[pos++] = (pcm[index + 1] * (1 - t) + pcm[next + 1] * t) / 32768;
    }
    this.offset = read - frames;
    const samples = output.subarray(0, pos);
    if (this.queue) this.queue.push(samples);
    else this.node.port.postMessage(samples, [output.buffer]);
  }

  startWav() {
    this.recording = { parts: [], size: 0, full: false };
  }

  stopWav() {
    const recording = this.recording;
    this.recording = null;
    if (!recording?.size) return null;
    const header = new ArrayBuffer(44);
    const view = new DataView(header);
    const text = (at, str) => new Uint8Array(header, at, str.length).set(new TextEncoder().encode(str));
    text(0, "RIFF");
    view.setUint32(4, 36 + recording.size, true);
    text(8, "WAVEfmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 2, true);
    view.setUint32(24, PCM_RATE, true);
    view.setUint32(28, PCM_RATE * 4, true);
    view.setUint16(32, 4, true);
    view.setUint16(34, 16, true);
    text(36, "data");
    view.setUint32(40, recording.size, true);
    return new Blob([header, ...recording.parts], { type: "audio/wav" });
  }
}
