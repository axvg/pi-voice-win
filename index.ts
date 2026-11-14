// pi-voice-win: hold Space on an empty prompt to dictate. Windows only.
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
	language?: string;
	threads: number;
	decode: "inline" | "worker";
	live: boolean;
	liveMs: number;
	device?: string;
	releaseMs: number;
	warmupRepeats: number;
	maxSec: number;
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-voice-win.json");
const cfg: Config = {
	model: "parakeet-v3",
	threads: Math.max(2, Math.floor(cpus().length / 2)),
	decode: "worker",
	live: true,
	liveMs: 1000,
	releaseMs: 350,
	warmupRepeats: 2,
	maxSec: 60,
	...(existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf8")) : {}),
};
if (cfg.live) cfg.decode = "worker";

const LOG = process.env.PI_VOICE_LOG;
const log = (m: string) => LOG && appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`);

// ---- microphone (int16 mono 16 kHz, 100 ms chunks) ----

interface Mic {
	chunks: Buffer[];
	level(): number;
	stop(): Promise<void>;
}

async function loadDecibri(): Promise<any> {
	const mod = (await import("decibri")) as any;
	return mod.default ?? mod;
}

function rms(b: Buffer): number {
	let acc = 0;
	for (let i = 0; i + 1 < b.length; i += 2) {
		const v = b.readInt16LE(i) / 32768;
		acc += v * v;
	}
	return Math.sqrt(acc / (b.length / 2));
}

function toFloat(chunks: Buffer[]): Float32Array {
	const all = Buffer.concat(chunks);
	const out = new Float32Array(all.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = all.readInt16LE(i * 2) / 32768;
	return out;
}

async function openMic(): Promise<Mic> {
	const Decibri = await loadDecibri();
	const chunks: Buffer[] = [];
	let last = 0;
	const mic = new Decibri({
		sampleRate: 16000,
		channels: 1,
		framesPerBuffer: 1600,
		...(cfg.device ? { device: cfg.device } : {}),
	});
	mic.on("data", (b: Buffer) => {
		chunks.push(b);
		last = rms(b);
	});
	await new Promise<void>((res, rej) => {
		mic.once("data", () => res());
		mic.once("error", rej);
		setTimeout(res, 1500);
	});
	return {
		chunks,
		level: () => last,
		stop: () =>
			new Promise((res) => {
				let done = false;
				const finish = () => {
					if (!done) res();
					done = true;
				};
				mic.once("close", finish);
				mic.once("end", finish);
				mic.stop();
				setTimeout(finish, 500);
			}),
	};
}

// ---- decoder ----

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
	worker.on("error", () => {});
	worker.on("exit", (code) => {
		decoderPromise = undefined;
		for (const p of pending.values()) p.rej(new Error(`decoder worker exited (code ${code})`));
		pending.clear();
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

// ---- session ----

let ctxRef: ExtensionContext | undefined;
let decoderPromise: Promise<Decoder> | undefined;
let mic: Mic | undefined;
let meter: NodeJS.Timeout | undefined;
let maxTimer: NodeJS.Timeout | undefined;
let committed = "";
let openFrom = 0;
let opening = false;
let stopAsked = false;
let insert: ((text: string) => void) | undefined;
let show: ((text: string) => void) | undefined;

function status(s?: string) {
	log(`status ${s ?? "-"}`);
	ctxRef?.ui.setStatus("voice", s);
}

function loadDecoder(): Promise<Decoder> {
	if (!decoderPromise) {
		const p = (async () => {
			const dir = await ensureModel(cfg.model, (m) => status(`voice: ${m}`));
			status("voice: loading model…");
			const d = await createDecoder(dir);
			status(undefined);
			return d;
		})();
		p.catch((e) => {
			decoderPromise = undefined;
			status(undefined);
			ctxRef?.ui.notify(`voice: ${e.message}`, "error");
		});
		decoderPromise = p;
	}
	return decoderPromise;
}

const BARS = "▁▂▃▄▅▆▇█";
const SILENCE_RMS = 0.012;

async function startRecording() {
	if (mic || opening) return;
	opening = true;
	let m: Mic;
	try {
		m = await openMic();
	} catch (e: any) {
		opening = false;
		stopAsked = false;
		ctxRef?.ui.notify(`voice: microphone unavailable (${e.message})`, "error");
		return;
	}
	opening = false;
	if (stopAsked) {
		stopAsked = false;
		await m.stop();
		return;
	}
	mic = m;
	void loadDecoder();
	const wave: number[] = [];
	meter = setInterval(() => {
		wave.push(Math.min(1, (mic?.level() ?? 0) * 8));
		if (wave.length > 24) wave.shift();
		status(`● REC ${wave.map((l) => BARS[Math.floor(l * (BARS.length - 1))]).join("")}`);
	}, 100);
	maxTimer = setTimeout(() => void stopRecording(), cfg.maxSec * 1000);
	status("● REC");
	if (cfg.live) void liveLoop(mic);
}

// Re-decode the open phrase every liveMs. A phrase commits after ~700 ms of silence,
// so each decode covers one phrase rather than the whole recording.
async function liveLoop(m: Mic) {
	committed = "";
	openFrom = 0;
	let partial = "";
	while (mic === m) {
		await new Promise((r) => setTimeout(r, cfg.liveMs));
		if (mic !== m || !decoderPromise) continue;
		const end = m.chunks.length;
		const open = m.chunks.slice(openFrom, end);
		if (open.length < 5) continue;
		if (open.every((b) => rms(b) < SILENCE_RMS)) {
			openFrom = end;
			continue;
		}
		const quiet = open.slice(-7).every((b) => rms(b) < SILENCE_RMS);
		try {
			partial = await (await loadDecoder()).recognize(toFloat(open));
			log(`partial ${JSON.stringify(partial)} ${open.length * 100}ms quiet=${quiet}`);
		} catch {
			continue;
		}
		if (mic !== m) break;
		if (quiet) {
			if (partial) committed = committed ? `${committed} ${partial}` : partial;
			openFrom = end;
			partial = "";
		}
		show?.([committed, partial].filter(Boolean).join(" "));
	}
}

async function stopRecording() {
	if (!mic) {
		if (opening) stopAsked = true;
		return;
	}
	clearInterval(meter);
	clearTimeout(maxTimer);
	const m = mic;
	mic = undefined;
	const done = committed;
	const from = openFrom;
	await m.stop();
	let open = cfg.live ? m.chunks.slice(from) : m.chunks;
	if (open.every((b) => rms(b) < SILENCE_RMS)) open = [];
	if (open.length < 3 && !done) return status(undefined);
	status("voice: transcribing…");
	try {
		let tail = "";
		if (open.length >= 3) {
			const d = await loadDecoder().catch(() => undefined);
			if (!d) return status(undefined);
			tail = await d.recognize(toFloat(open));
		}
		const text = cfg.live ? [done, tail].filter(Boolean).join(" ") : tail;
		log(`text ${JSON.stringify(text)} (${(m.chunks.length / 10).toFixed(1)}s)`);
		if (cfg.live) show?.(text);
		else if (text) insert?.(text);
	} catch (e: any) {
		ctxRef?.ui.notify(`voice: ${e.message}`, "error");
	}
	status(undefined);
}

// ---- editor ----

const isSpace = (d: string) => d === " " || /^\x1b\[32(?:;[\d:]+)?u$/.test(d) || matchesKey(d, "space");

class VoiceEditor extends CustomEditor {
	wantsKeyRelease = true;
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
		if (LOG && isSpace(data)) log(`key ${JSON.stringify(data)} release=${isKeyRelease(data)}`);
		if (isKeyRelease(data)) {
			if (isSpace(data)) this.hold.release();
			return;
		}
		if (isSpace(data) && (this.hold.active || this.getText().trim() === "")) {
			insert = (t) => {
				const cur = this.getText();
				this.setText(cur ? `${cur} ${t}` : t);
			};
			show = (t) => this.setText(t);
			this.hold.space();
			return;
		}
		this.hold.otherKey();
		super.handleInput(data);
	}
}

export default function (pi: ExtensionAPI) {
	if (process.platform !== "win32") return;

	pi.on("session_start", (_e, ctx) => {
		ctxRef = ctx;
		if (!ctx.hasUI) return;
		ctx.ui.setEditorComponent((tui, theme, kb) => new VoiceEditor(tui, theme, kb));
		void loadDecoder();
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
			insert = (t) => ctx.ui.setEditorText(t);
			show = (t) => ctx.ui.setEditorText(t);
			if (mic) await stopRecording();
			else await startRecording();
		},
	});
}
