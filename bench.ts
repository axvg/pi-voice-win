// bench.ts: `npx tsx bench.ts [parakeet-v3|canary-180m] [file.wav]` prints text and RTF. Downloads the model if missing.
import { createStt, ensureModel, type ModelName } from "./stt.js";
const name = (process.argv[2] ?? "parakeet-v3") as ModelName;
const dir = await ensureModel(name, (m) => process.stderr.write(`\r${m}   `));
const mod: any = await import("sherpa-onnx-node");
const ns = mod.default ?? mod;
const t0 = Date.now();
const stt = await createStt(name, dir);
console.error(`\nload ${Date.now() - t0} ms`);
const wav = ns.readWave(process.argv[3] ?? `${dir}/test_wavs/en.wav`);
const t1 = Date.now();
const text = stt.recognize(wav.samples);
const el = (Date.now() - t1) / 1000, dur = wav.samples.length / wav.sampleRate;
console.log(JSON.stringify({ text, dur, el, rtf: +(el / dur).toFixed(3) }));
