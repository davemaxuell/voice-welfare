import { createClapDetector } from "./clap.ts";

class ClapProcessor extends AudioWorkletProcessor {
  frame = new Float32Array(Math.round(sampleRate * 0.020));
  used = 0;
  detect = createClapDetector(sampleRate);
  stopped = false;
  constructor() {
    super();
    this.port.onmessage = () => { this.stopped = true; };
  }
  process(inputs: Float32Array[][]) {
    if (this.stopped) return false;
    const samples = inputs[0]?.[0];
    if (samples === undefined) return true;
    for (let i = 0; i < samples.length; i++) {
      this.frame[this.used++] = samples[i] ?? 0;
      if (this.used === this.frame.length) {
        const at = (currentFrame + i + 1) / sampleRate;
        if (this.detect(this.frame, at * 1000)) this.port.postMessage(at);
        this.used = 0;
      }
    }
    return true;
  }
}

registerProcessor("double-clap", ClapProcessor);
