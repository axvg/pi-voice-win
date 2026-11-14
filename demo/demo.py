# Scripted stand-in for pi's footer, used by demo.tape. Timings from real runs.
import sys, time, json, random
random.seed(3)
W, H = 80, 6
BARS = "▁▂▃▄▅▆▇█"
def screen(footer, prompt=""):
    return ("\x1b[?25l\x1b[H\x1b[J\x1b[2m pi 0.84  ·  claude-opus-4.5  ·  ~/repos/app\x1b[0m\n\n"
            "\x1b[36m>\x1b[0m " + prompt + "\n\n\x1b[2m" + footer + "\x1b[0m")
# Partial text by 100 ms tick. Tick 20 gets revised at tick 30.
partials = {10: "Refactoriza el", 20: "Refactoriza el parse de", 30: "Refactoriza el parser de config",
            50: "Refactoriza el parser de config y añade test",
            60: "Refactoriza el parser de config y añade tests para los"}
full = "Refactoriza el parser de config y añade tests para los casos de error."
frames = [(0, screen("hold Space to dictate")), (0.8, screen("keep holding…"))]
wave, prompt = [], ""
for i in range(66):
    speaking = i < 33 or i >= 40
    wave.append(random.choice([2, 3, 4, 5, 6, 7, 5, 3]) if speaking else random.choice([0, 0, 1]))
    prompt = partials.get(i, prompt)
    bars = "".join(BARS[v] for v in wave[-24:]).rjust(24, BARS[0])
    frames.append((1.3 + i / 10, screen("\x1b[31m●\x1b[0m REC " + bars, prompt)))
frames += [(7.9, screen("voice: transcribing…", prompt)), (8.6, screen("", full)), (11.6, "")]
if len(sys.argv) == 3 and sys.argv[1] == "--cast":
    with open(sys.argv[2], "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps({"version": 2, "width": W, "height": H}) + "\n")
        for t, d in frames:
            f.write(json.dumps([round(t, 3), "o", d.replace("\n", "\r\n")], ensure_ascii=False) + "\n")
else:
    start = time.time()
    for t, d in frames:
        time.sleep(max(0, start + t - time.time()))
        sys.stdout.write(d)
        sys.stdout.flush()
