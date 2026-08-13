/**
 * pi-voice-win: hold Space on an empty prompt to dictate, like Claude Code. Windows only.
 *
 * Hold detection: most terminals send no key-up, so we watch key-repeat. First Space types
 * normally; once repeats arrive the typed spaces are removed and the mic opens. When
 * repeats stop for `releaseMs` the mic closes and the transcript is inserted. Terminals
 * with the kitty keyboard protocol deliver a real key-up and stop instantly.
 * Fallback: `/voice` toggles recording for terminals without key-repeat.
 */
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HoldDetector } from "./hold.js";
import { createStt, ensureModel, type ModelName, type Stt } from "./stt.js";

interface Config {
	model: ModelName;
	language?: string; // only canary-180m needs it; parakeet auto-detects
	threads: number;
	releaseMs: number; // gap between repeats that means "released". Windows slowest repeat = 500 ms.
	warmupRepeats: number; // repeats before recording starts (avoids a tap+slow-repeat starting the mic)
}
const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-voice-win.json");
const cfg: Config = {
	model: "parakeet-v3",
	threads: 4,
	releaseMs: 350,
	warmupRepeats: 2,
	...(existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf8")) : {}),
};

// mic
interface Mic {
	stop(): Promise<Float32Array>;
	level(): number; // 0..1 rms of last chunk
}
async function openMic(): Promise<Mic> {
	const mod = (await import("decibri")) as any;
	const Decibri = mod.default ?? mod;
	const chunks: Buffer[] = [];
	let rms = 0;
	const mic = new Decibri({ sampleRate: 16000, channels: 1, framesPerBuffer: 1600 });
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
		setTimeout(res, 1500); // ponytail: optimistic start; real errors surface on stop()
	});
	return {
		level: () => rms,
		stop: () =>
			new Promise((res) => {
				mic.once("close", finish);
				mic.once("end", finish);
				mic.stop();
				setTimeout(finish, 500);
				let done = false;
				function finish() {
					if (done) return;
					done = true;
					const all = Buffer.concat(chunks);
					const out = new Float32Array(all.length / 2);
					for (let i = 0; i < out.length; i++) out[i] = all.readInt16LE(i * 2) / 32768;
					res(out);
				}
			}),
	};
}

// state shared between editor instances and commands
let ctxRef: ExtensionContext | undefined;
let sttPromise: Promise<Stt> | undefined;
let mic: Mic | undefined;
let meter: NodeJS.Timeout | undefined;
let insert: ((text: string) => void) | undefined;

const LOG = process.env.PI_VOICE_LOG; // debug: append events to this file
const log = (m: string) => LOG && appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`);
const status = (s?: string) => {
	log(`status ${s ?? "-"}`);
	ctxRef?.ui.setStatus("voice", s);
};

function loadStt(): Promise<Stt> {
	sttPromise ??= (async () => {
		const dir = await ensureModel(cfg.model, (m) => status(`voice: ${m}`));
		status("voice: loading model…");
		const stt = await createStt(cfg.model, dir, cfg.language, cfg.threads);
		status(undefined);
		return stt;
	})();
	sttPromise.catch((e) => {
		sttPromise = undefined;
		status(undefined);
		ctxRef?.ui.notify(`voice: ${e.message}`, "error");
	});
	return sttPromise;
}

async function startRecording() {
	if (mic) return;
	try {
		mic = await openMic();
	} catch (e: any) {
		ctxRef?.ui.notify(`voice: microphone unavailable (${e.message})`, "error");
		return;
	}
	void loadStt();
	const bars = "▁▂▃▄▅▆▇█";
	meter = setInterval(() => {
		const l = Math.min(1, (mic?.level() ?? 0) * 8);
		status(`● REC ${bars[Math.floor(l * (bars.length - 1))]}`);
	}, 100);
	status("● REC");
}

async function stopRecording() {
	if (!mic) return;
	clearInterval(meter);
	const samples = await mic.stop();
	mic = undefined;
	if (samples.length < 16000 * 0.3) return status(undefined); // <300 ms: ignore
	status("voice: transcribing…");
	try {
		const stt = await loadStt();
		// ponytail: decode blocks the event loop ~0.25x audio length; move to a worker_thread if it annoys.
		const text = stt.recognize(samples);
		log(`text ${JSON.stringify(text)} (${(samples.length / 16000).toFixed(1)}s)`);
		if (text) insert?.(text);
	} catch {
		/* notified in loadStt */
	}
	status(undefined);
}

// editor
// Space as a plain char, or a kitty CSI-u sequence (codepoint 32) for press, repeat or release.
const isSpace = (d: string) => d === " " || /^\x1b\[32(?:;[\d:]+)?u$/.test(d) || matchesKey(d, "space");

class VoiceEditor extends CustomEditor {
	wantsKeyRelease = true; // kitty protocol (Windows Terminal ≥1.22, WezTerm, Ghostty): real key-up
	private hold = new HoldDetector(
		{
			typeSpace: () => super.handleInput(" "),
			start: () => {
				this.setText(this.getText().replace(/^ +$/, ""));
				void startRecording();
			},
			stop: () => void stopRecording(),
		},
		{ initialDelayMs: 1100, releaseMs: cfg.releaseMs, warmupRepeats: cfg.warmupRepeats },
	);

	handleInput(data: string): void {
		if (LOG && isSpace(data)) log(`key ${JSON.stringify(data)} release=${isKeyRelease(data)} active=${this.hold.active}`);
		if (isKeyRelease(data)) {
			if (isSpace(data)) this.hold.release();
			return; // base editor never sees release events
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
		const prev = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, theme, kb) => new VoiceEditor(tui, theme, kb));
		void prev; // ponytail: no composition with other custom editors; wrap `prev` if you need vim+voice.
		void loadStt(); // warm the model so the first hold is instant
	});

	pi.registerCommand("voice", {
		description: "Toggle voice recording (fallback when Space hold-detection is unavailable)",
		handler: async (ctx) => {
			insert ??= (t) => ctx.ui.setEditorText(t);
			if (mic) await stopRecording();
			else await startRecording();
		},
	});
}
