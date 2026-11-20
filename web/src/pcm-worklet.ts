// The microphone AudioContext resamples to 24 kHz. Emit 40 ms of little-endian mono PCM16.
class MicrophonePcm extends AudioWorkletProcessor {
  chunk = new DataView(new ArrayBuffer(1920));
  used = 0;
  constructor() {
    super();
    this.port.onmessage = () => {
      if (this.used !== 0) this.emit();
      this.port.postMessage("flushed");
    };
  }
  emit() {
    const frame = this.chunk.buffer.slice(0, this.used);
    this.port.postMessage(frame, [frame]);
    this.used = 0;
  }
  process(inputs: Float32Array[][]) {
    const samples = inputs[0]?.[0];
    if (samples !== undefined) for (const sample of samples) {
      const value = Math.max(-1, Math.min(1, sample));
      this.chunk.setInt16(this.used, Math.round(value * (value < 0 ? 32768 : 32767)), true);
      this.used += 2;
      if (this.used === this.chunk.byteLength) this.emit();
    }
    return true;
  }
}
registerProcessor("microphone-pcm", MicrophonePcm);
