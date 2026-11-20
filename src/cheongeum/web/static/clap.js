// Feed consecutive 20 ms mono frames. Times come from the audio clock.
export function createClapDetector(sampleRate) {
    let background = 0.01;
    let lastPeakAt = -Infinity;
    let firstClapAt = -Infinity;
    return (samples, nowMs) => {
        let peak = 0;
        let energy = 0;
        let change = 0;
        let previous = samples[0];
        for (const value of samples) {
            peak = Math.max(peak, Math.abs(value));
            energy += value * value;
            change += (value - previous) ** 2;
            previous = value;
        }
        const rms = Math.sqrt(energy / samples.length);
        // Low-frequency knocks can have just as sharp a peak as a hand clap.
        const bright = change > energy * (0.25 * 44100 / sampleRate) ** 2;
        const clap = peak > Math.max(0.3, background * 8) && peak > rms * 4 && bright;
        background = background * 0.95 + rms * 0.05;
        if (!clap || nowMs - lastPeakAt <= 120)
            return false;
        lastPeakAt = nowMs;
        const gap = nowMs - firstClapAt;
        if (gap >= 150 && gap <= 800) {
            firstClapAt = -Infinity;
            return true;
        }
        firstClapAt = nowMs;
        return false;
    };
}
