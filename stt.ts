import { execFile } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

export const MODELS = {
	"parakeet-v3": {
		url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2",
		dir: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
		config: (d: string, _lang: string | undefined) => ({
			transducer: {
				encoder: join(d, "encoder.int8.onnx"),
				decoder: join(d, "decoder.int8.onnx"),
				joiner: join(d, "joiner.int8.onnx"),
			},
			modelType: "nemo_transducer",
		}),
	},
	"canary-180m": {
		url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8.tar.bz2",
		dir: "sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8",
		config: (d: string, lang = "en") => ({
			canary: {
				encoder: join(d, "encoder.int8.onnx"),
				decoder: join(d, "decoder.int8.onnx"),
				srcLang: lang,
				tgtLang: lang,
				usePnc: 1,
			},
		}),
	},
} as const;
export type ModelName = keyof typeof MODELS;

export const MODELS_ROOT = join(homedir(), ".pi", "models");

export async function ensureModel(name: ModelName, onProgress?: (msg: string) => void): Promise<string> {
	const m = MODELS[name];
	const dir = join(MODELS_ROOT, m.dir);
	const tmp = join(MODELS_ROOT, `${m.dir}.tar.bz2`);
	if (existsSync(join(dir, "tokens.txt")) && !existsSync(tmp)) return dir;
	mkdirSync(MODELS_ROOT, { recursive: true });
	if (!existsSync(tmp)) await download(m.url, tmp, onProgress);
	onProgress?.("extracting (bz2, a few minutes)…");
	// System32\tar.exe (bsdtar) hangs on these archives; Git's GNU tar works. Pi needs Git Bash on Windows anyway.
	const gitTar = "C:\\Program Files\\Git\\usr\\bin\\tar.exe";
	await promisify(execFile)(existsSync(gitTar) ? gitTar : "tar", ["-xjf", tmp, "-C", MODELS_ROOT]);
	rmSync(tmp, { force: true });
	if (!existsSync(join(dir, "tokens.txt"))) throw new Error("extraction failed");
	return dir;
}

async function download(url: string, tmp: string, onProgress?: (msg: string) => void) {
	onProgress?.("downloading model…");
	const res = await fetch(url);
	if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
	const total = Number(res.headers.get("content-length") ?? 0);
	let got = 0;
	let last = -1;
	const counter = new Transform({
		transform(chunk, _e, cb) {
			got += chunk.length;
			const pct = total ? Math.round((got / total) * 100) : 0;
			if (pct !== last) onProgress?.(`downloading model ${(last = pct)}%`);
			cb(null, chunk);
		},
	});
	await pipeline(Readable.fromWeb(res.body as any), counter, createWriteStream(`${tmp}.part`));
	renameSync(`${tmp}.part`, tmp);
}

export interface Stt {
	recognize(samples: Float32Array): string;
}

export async function createStt(name: ModelName, dir: string, lang?: string, numThreads = 4): Promise<Stt> {
	const mod = (await import("sherpa-onnx-node")) as any;
	const ns = mod.default ?? mod;
	const build = (l: string | undefined) => ({
		featConfig: { sampleRate: 16000, featureDim: 80 },
		modelConfig: {
			...MODELS[name].config(dir, l),
			tokens: join(dir, "tokens.txt"),
			numThreads,
			provider: "cpu",
			debug: 0,
		},
	});
	const recognizer = new ns.OfflineRecognizer(build(lang));
	return {
		recognize(samples) {
			if (samples.length < 1600) return "";
			const s = recognizer.createStream();
			s.acceptWaveform({ samples, sampleRate: 16000 });
			recognizer.decode(s);
			return String(recognizer.getResult(s).text ?? "").trim();
		},
	};
}
