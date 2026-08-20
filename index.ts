/**
 * pi-voice-win: hold Space on an empty prompt to dictate, like Claude Code. Windows only.
 *
 * Hold detection: most terminals send no key-up, so we watch key-repeat. The first Space
 * types a space as usual. Once repeats arrive the space is removed and the mic opens. When
 * repeats stop for `releaseMs` the mic closes and the transcript is inserted. Terminals
 * with the kitty keyboard protocol deliver a real key-up and stop at once.
 * Fallback: `/voice` toggles recording for terminals without key-repeat.
 */
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { cpus, homedir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { HoldDetector } from "./hold.ts";
import { createStt, ensureModel, type ModelName } from "./stt.ts";

interface Config {
	model: ModelName;
	language?: string; // only canary-180m uses it; parakeet auto-detects
	threads: number; // default: half the logical CPUs, at least 2
	decode: "inline" | "worker"; // inline blocks the UI ~0.25x audio length; worker keeps it responsive, costs ~1 GB more RAM
	device?: string; // mic name substring, e.g. "headset". Default: system default input. `/voice devices` lists them
	releaseMs: number; // gap between key-repeats that means "released". Windows slowest repeat rate is 500 ms
	warmupRepeats: number; // repeats before the mic opens. Two quick taps on an empty prompt also count
	maxSec: number; // hard stop, in case the hold never releases
}
const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-voice-win.json");
const cfg: Config = {
	model: "parakeet-v3",
	threads: Math.max(2, Math.floor(cpus().length / 2)),
	decode: "inline",
	releaseMs: 350,
	warmupRepeats: 2,
	maxSec: 60,
	...(existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf8")) : {}),
};

const LOG = process.env.PI_VOICE_LOG; // debug: append key and status events to this file
const log = (m: string) => LOG && appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`);

// mic
interface Mic {
	stop(): Promise<Float32Array>;
	level(): number; // rms of the last chunk, 0..1
}
async function loadDecibri(): Promise<any> {
	const mod = (await import("decibri")) as any;
	return mod.default ?? mod;
}
async function openMic(): Promise<Mic> {
	const Decibri = await loadDecibri();
	const chunks: Buffer[] = [];
	let rms = 0;
	const mic = new Decibri({ sampleRate: 16000, channels: 1, framesPerBuffer: 1600, ...(cfg.device ? { device: cfg.device } : {}) });
	mic.on("data", (b: Buffer) => {
		chunks.push(b);
		let acc = 0;
		for (let i = 0; i + 1 < b.length; i += 2) {
			const v = b.readInt16LE(i) / 32768;
			acc += v * v;
		}
		rms = Math.sqrt(acc / (b.length / 2));
	});
	await new Promise<void>((res, rej) => {
		mic.once("data", () => res());
		mic.once("error", rej);
		setTimeout(res, 1500); // ponytail: optimistic start; a device error after this only shows up as silence
	});
	return {
		level: () => rms,
		stop: () =>
			new Promise((res) => {
				let done = false;
				const finish = () => {
					if (done) return;
					done = true;
					const all = Buffer.concat(chunks);
					const out = new Float32Array(all.length / 2);
					for (let i = 0; i < out.length; i++) out[i] = all.readInt16LE(i * 2) / 32768;
					res(out);
				};
				mic.once("close", finish);
				mic.once("end", finish);
				mic.stop();
				setTimeout(finish, 500);
			}),
	};
}

// decoder: inline (sync, blocks UI) or worker thread
interface Decoder {
	recognize(samples: Float32Array): Promise<string>;
}
async function createDecoder(dir: string): Promise<Decoder> {
	if (cfg.decode !== "worker") {
		const stt = await createStt(cfg.model, dir, cfg.language, cfg.threads);
		return { recognize: async (s) => stt.recognize(s) };
	}
	const worker = new Worker(new URL("./worker.ts", import.meta.url), {
		workerData: { name: cfg.model, dir, lang: cfg.language, threads: cfg.threads },
	});
	const pending = new Map<number, { res: (t: string) => void; rej: (e: Error) => void }>();
	let id = 0;
	await new Promise<void>((res, rej) => {
		worker.once("message", () => res());
		worker.once("error", rej);
	});
	worker.on("message", (m: { id: number; text?: string; error?: string }) => {
		const p = pending.get(m.id);
		pending.delete(m.id);
		if (!p) return;
		if (m.error) p.rej(new Error(m.error));
		else p.res(m.text ?? "");
	});
	worker.unref();
	return {
		recognize: (samples) =>
			new Promise((res, rej) => {
				pending.set(++id, { res, rej });
				worker.postMessage({ id, samples }, [samples.buffer]);
			}),
	};
}

// shared state
let ctxRef: ExtensionContext | undefined;
let decoderPromise: Promise<Decoder> | undefined;
let mic: Mic | undefined;
let meter: NodeJS.Timeout | undefined;
let maxTimer: NodeJS.Timeout | undefined;
let insert: ((text: string) => void) | undefined;

const status = (s?: string) => {
	log(`status ${s ?? "-"}`);
	ctxRef?.ui.setStatus("voice", s);
};

function loadDecoder(): Promise<Decoder> {
	decoderPromise ??= (async () => {
		const dir = await ensureModel(cfg.model, (m) => status(`voice: ${m}`));
		status("voice: loading model…");
		const d = await createDecoder(dir);
		status(undefined);
		return d;
	})();
	decoderPromise.catch((e) => {
		decoderPromise = undefined;
		status(undefined);
		ctxRef?.ui.notify(`voice: ${e.message}`, "error");
	});
	return decoderPromise;
}

const BARS = "▁▂▃▄▅▆▇█";
async function startRecording() {
	if (mic) return;
	try {
		mic = await openMic();
	} catch (e: any) {
		ctxRef?.ui.notify(`voice: microphone unavailable (${e.message})`, "error");
		return;
	}
	void loadDecoder();
	const wave: number[] = [];
	meter = setInterval(() => {
		wave.push(Math.min(1, (mic?.level() ?? 0) * 8));
		if (wave.length > 24) wave.shift();
		status(`● REC ${wave.map((l) => BARS[Math.floor(l * (BARS.length - 1))]).join("")}`);
	}, 100);
	maxTimer = setTimeout(() => void stopRecording(), cfg.maxSec * 1000);
	status("● REC");
}

async function stopRecording() {
	if (!mic) return;
	clearInterval(meter);
	clearTimeout(maxTimer);
	const m = mic;
	mic = undefined;
	const samples = await m.stop();
	if (samples.length < 16000 * 0.3) return status(undefined); // under 300 ms: ignore
	status("voice: transcribing…");
	const secs = (samples.length / 16000).toFixed(1);
	try {
		const text = await (await loadDecoder()).recognize(samples);
		log(`text ${JSON.stringify(text)} (${secs}s)`);
		if (text) insert?.(text);
	} catch (e: any) {
		ctxRef?.ui.notify(`voice: ${e.message}`, "error");
	}
	status(undefined);
}

// editor
// Space as a plain char, or a kitty CSI-u sequence (codepoint 32) for press, repeat or release.
const isSpace = (d: string) => d === " " || /^\x1b\[32(?:;[\d:]+)?u$/.test(d) || matchesKey(d, "space");

class VoiceEditor extends CustomEditor {
	wantsKeyRelease = true; // kitty protocol (Windows Terminal 1.22+, WezTerm, Ghostty): real key-up
	private hold = new HoldDetector(
		{
			typeSpace: () => {
				super.handleInput(" ");
				if (!mic) status("keep holding…");
			},
			start: () => {
				this.setText(this.getText().replace(/^ +$/, ""));
				void startRecording();
			},
			stop: () => void stopRecording(),
			cancel: () => status(undefined),
		},
		{ initialDelayMs: 1100, releaseMs: cfg.releaseMs, warmupRepeats: cfg.warmupRepeats },
	);

	handleInput(data: string): void {
		if (LOG && isSpace(data)) log(`key ${JSON.stringify(data)} release=${isKeyRelease(data)} active=${this.hold.active}`);
		if (isKeyRelease(data)) {
			if (isSpace(data)) this.hold.release();
			return; // the base editor never sees release events
		}
		if (isSpace(data) && (this.hold.active || this.getText().trim() === "")) {
			insert = (t) => {
				const cur = this.getText();
				this.setText(cur ? `${cur} ${t}` : t);
			};
			this.hold.space();
			return;
		}
		this.hold.otherKey();
		super.handleInput(data);
	}
}

// extension entry
export default function (pi: ExtensionAPI) {
	if (process.platform !== "win32") return;

	pi.on("session_start", (_e, ctx) => {
		ctxRef = ctx;
		if (!ctx.hasUI) return;
		ctx.ui.setEditorComponent((tui, theme, kb) => new VoiceEditor(tui, theme, kb));
		// ponytail: replaces any other custom editor (vim mode). Wrap ctx.ui.getEditorComponent() if you need both.
		void loadDecoder(); // warm the model so the first hold is instant
	});

	pi.registerCommand("voice", {
		description: "Toggle voice recording. `/voice devices` lists microphones",
		handler: async (args, ctx) => {
			if (args?.trim() === "devices") {
				const Decibri = await loadDecibri();
				const list = (Decibri.devices?.() ?? []) as { name: string; isDefault: boolean; defaultSampleRate: number }[];
				const lines = list.map((d) => `${d.isDefault ? "* " : "  "}${d.name} (${d.defaultSampleRate} Hz)`);
				ctx.ui.notify(lines.join("\n") || "no input devices", "info");
				return;
			}
			insert ??= (t) => ctx.ui.setEditorText(t);
			if (mic) await stopRecording();
			else await startRecording();
		},
	});
}
