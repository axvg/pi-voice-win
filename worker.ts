// Decoder thread. Runs under Node's type stripping, hence the .ts import.
import { parentPort, workerData } from "node:worker_threads";
import { createStt, type ModelName } from "./stt.ts";

const { name, dir, lang, threads } = workerData as { name: ModelName; dir: string; lang?: string; threads: number };
const stt = await createStt(name, dir, lang, threads);
parentPort!.postMessage({ ready: true });
parentPort!.on("message", (m: { id: number; samples: Float32Array }) => {
	try {
		parentPort!.postMessage({ id: m.id, text: stt.recognize(m.samples) });
	} catch (e: any) {
		parentPort!.postMessage({ id: m.id, error: String(e?.message ?? e) });
	}
});
