// Key-repeat based hold detector. Self-check: `npx tsx hold.ts`.
export interface HoldEvents {
	typeSpace(): void;
	start(warmupSpacesTyped: number): void;
	stop(): void;
	cancel?(): void;
}
export interface HoldOpts {
	initialDelayMs: number;
	releaseMs: number;
	warmupRepeats: number;
	now?: () => number;
	setTimeout?: (fn: () => void, ms: number) => unknown;
	clearTimeout?: (t: unknown) => void;
}

export class HoldDetector {
	private typed = 0;
	private repeats = 0;
	private timer: unknown;
	holding = false;
	constructor(
		private ev: HoldEvents,
		private o: HoldOpts,
	) {}

	/** Call on every Space keypress when the prompt is empty (or a hold is in progress). */
	space(): void {
		if (this.timer === undefined) {
			this.typed = 1;
			this.repeats = 0;
			this.ev.typeSpace();
			this.arm(this.o.initialDelayMs);
			return;
		}
		this.repeats++;
		if (this.holding) return this.arm(this.o.releaseMs);
		if (this.repeats < this.o.warmupRepeats) {
			this.typed++;
			this.ev.typeSpace();
			return this.arm(this.o.initialDelayMs);
		}
		this.holding = true;
		this.ev.start(this.typed);
		this.arm(this.o.releaseMs);
	}

	/** Real key-up (kitty keyboard protocol): stop immediately, or cancel a pending warmup. */
	release(): void {
		if (this.timer !== undefined) this.released();
	}

	/** Any other key cancels a pending warmup (it was a tap). Does not stop a hold. */
	otherKey(): void {
		if (this.holding || this.timer === undefined) return;
		this.reset();
		this.ev.cancel?.();
	}

	/** True while Space presses should be swallowed (hold active). */
	get active(): boolean {
		return this.timer !== undefined;
	}

	private arm(ms: number) {
		(this.o.clearTimeout ?? clearTimeout)(this.timer as any);
		this.timer = (this.o.setTimeout ?? setTimeout)(() => this.released(), ms);
	}
	private released() {
		const was = this.holding;
		this.reset();
		if (was) this.ev.stop();
		else this.ev.cancel?.();
	}
	private reset() {
		(this.o.clearTimeout ?? clearTimeout)(this.timer as any);
		this.timer = undefined;
		this.holding = false;
		this.repeats = 0;
		this.typed = 0;
	}
}

// self-check
if (process.argv[1] && /hold\.ts$/.test(process.argv[1])) {
	const assert = (await import("node:assert")).strict;
	const run = (presses: number[], extra?: (d: HoldDetector, log: string[]) => void) => {
		const log: string[] = [];
		let pending: { fn: () => void; at: number }[] = [];
		let t = 0;
		const d = new HoldDetector(
			{
				typeSpace: () => log.push("sp"),
				start: (n) => log.push(`start${n}`),
				stop: () => log.push("stop"),
				cancel: () => log.push("cancel"),
			},
			{
				initialDelayMs: 1100,
				releaseMs: 350,
				warmupRepeats: 2,
				setTimeout: (fn, ms) => {
					const h = { fn, at: t + ms };
					pending.push(h);
					return h;
				},
				clearTimeout: (h) => (pending = pending.filter((p) => p !== h)),
			},
		);
		const advance = (to: number) => {
			while (pending.length && Math.min(...pending.map((p) => p.at)) <= to) {
				const next = pending.sort((a, b) => a.at - b.at)[0]!;
				pending.shift();
				t = next.at;
				next.fn();
			}
			t = to;
		};
		for (const at of presses) {
			advance(at);
			d.space();
		}
		extra?.(d, log);
		advance(t + 5000);
		return log.join(",");
	};
	assert.equal(run([0]), "sp,cancel");
	const held = [0, 500, 530, 560, 590, 620];
	assert.equal(run(held), "sp,sp,start2,stop");
	assert.equal(
		run([0], (d) => d.otherKey()),
		"sp,cancel",
	);
	assert.equal(run([0, 200, 400]), "sp,sp,start2,stop");
	assert.equal(
		run([0, 500, 530], (d, log) => {
			d.release();
			log.push("t" + 0);
		}),
		"sp,sp,start2,stop,t0",
	);
	assert.equal(
		run([0], (d) => d.release()),
		"sp,cancel",
	);
	console.log("hold.ts ok");
}
