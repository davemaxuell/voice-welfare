// node scripts/eval-claps.ts <ESC-50/audio> [additional non-clap recordings...]
// Source and replay protocol are in drafts/future implementations/double-clap detector - test and tune.md.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createClapDetector } from '../web/src/clap.ts';

const folder = process.argv[2];
if (folder === '--help') { console.log('node scripts/eval-claps.ts <ESC-50/audio> [additional non-clap recordings...]'); process.exit(0); }
if (folder === undefined || folder.length === 0) throw new Error('Pass the ESC-50 audio directory (ffmpeg must be on PATH).');
const rate = 44100;
const hop = rate / 50;
function read(path: string) {
    const bytes = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1',
        '-ar', String(rate), '-f', 'f32le', 'pipe:1'], { maxBuffer: 64 * 1024 * 1024 });
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
}

// Each interval contains two distinct recorded claps and the original pause between them.
const crops: Record<string, [number, number][]> = {
    '2-76408-A-22.wav': [[0, 0.86], [0.90, 1.65], [1.70, 2.50], [2.51, 3.30], [3.32, 4.08], [4.12, 4.94]],
    '1-104089-A-22.wav': [[0, 0.40]],
    '2-25293-A-22.wav': [[2.12, 2.73]],
};
function count(samples: Float32Array, phase: number) {
    const detect = createClapDetector(rate);
    const padded = new Float32Array(samples.length + phase + hop);
    padded.set(samples, phase);
    let count = 0;
    for (let i = 0; i + hop <= padded.length; i += hop) {
        if (detect(padded.subarray(i, i + hop), (i + hop) * 1000 / rate)) count++;
    }
    return count;
}
let hits = 0, singles = 0, trials = 0;
for (const [name, intervals] of Object.entries(crops)) {
    const audio = read(join(folder, name));
    for (const [start, end] of intervals) {
        for (let phase = 0; phase < hop; phase += hop / 6) {
            trials++;
            if (count(audio.subarray(start * rate, end * rate), phase) === 1) hits++;
            const firstOnly = audio.subarray(start * rate, (start + end) / 2 * rate);
            if (count(firstOnly, phase) > 0) singles++;
        }
    }
}
console.log(`Recorded pairs triggering exactly once: ${hits}/${trials} replays (8 pairs x 6 offsets)`);
console.log(`First clap in isolation: ${singles}/${trials} false triggers`);
for (const fold of [1, 2]) {
    const clips = readdirSync(folder).filter(name => name.startsWith(fold + '-') && /-(24|30|32)\.wav$/.test(name));
    if (clips.length !== 24) throw new Error(`Expected all 24 cough, knock and keyboard clips in fold ${fold}`);
    const wrong = clips.filter(name => count(read(join(folder, name)), 0) > 0);
    console.log(`Fold ${fold}: ${wrong.length}/24 noise clips triggered: ${wrong.join(', ')}`);
}
for (const path of process.argv.slice(3)) {
    const samples = read(path);
    const peak = samples.reduce((p, v) => Math.max(p, Math.abs(v)), 0);
    const loud = samples.map(v => peak > 0 ? v / peak : v);
    console.log(`${path}: ${count(samples, 0)} triggers at recorded level, ${count(loud, 0)} at full peak`);
}
