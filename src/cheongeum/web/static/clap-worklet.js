import { createClapDetector } from './clap.js';

class ClapProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.frame = new Float32Array(Math.round(sampleRate * 0.020));
        this.used = 0;
        this.detect = createClapDetector(sampleRate);
        this.stopped = false;
        this.port.onmessage = () => { this.stopped = true; };
    }
    process(inputs) {
        if (this.stopped)
            return false;
        const samples = inputs[0]?.[0];
        if (!samples)
            return true;
        for (let i = 0; i < samples.length; i++) {
            this.frame[this.used++] = samples[i];
            if (this.used === this.frame.length) {
                const at = (currentFrame + i + 1) / sampleRate;
                if (this.detect(this.frame, at * 1000))
                    this.port.postMessage(at);
                this.used = 0;
            }
        }
        return true;
    }
}

registerProcessor('double-clap', ClapProcessor);
