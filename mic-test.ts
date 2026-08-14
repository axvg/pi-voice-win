// mic-test.ts: records N seconds from the default mic and prints the transcript. `npx tsx mic-test.ts 4`
import { createStt, ensureModel } from "./stt.js";
const mod: any = await import("decibri"); const Decibri = mod.default ?? mod;
console.error("devices:", Decibri.devices?.().map((d: any) => `${d.isDefault ? "*" : " "}${d.name}@${d.defaultSampleRate}`).join(" | "));
const secs = Number(process.argv[2] ?? 4);
const chunks: Buffer[] = [];
const mic = new Decibri({ sampleRate: 16000, channels: 1, framesPerBuffer: 1600 });
mic.on("data", (b: Buffer) => chunks.push(b));
mic.on("error", (e: Error) => { console.error("mic error", e); process.exit(1); });
console.error(`recording ${secs}s… speak`);
await new Promise((r) => setTimeout(r, secs * 1000));
mic.stop();
const all = Buffer.concat(chunks);
const f = new Float32Array(all.length / 2);
let peak = 0; for (let i = 0; i < f.length; i++) { f[i] = all.readInt16LE(i * 2) / 32768; peak = Math.max(peak, Math.abs(f[i])); }
console.error(`got ${f.length / 16000}s, peak ${peak.toFixed(3)}`);
const stt = await createStt("parakeet-v3", await ensureModel("parakeet-v3"));
const t = Date.now(); console.log(JSON.stringify({ text: stt.recognize(f), ms: Date.now() - t }));
process.exit(0);
