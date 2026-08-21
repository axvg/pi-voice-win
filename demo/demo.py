# Scripted stand-in for pi's footer, used by demo.tape. Timings from real runs.
import sys, time
ESC = "\x1b["
def w(s): sys.stdout.write(s); sys.stdout.flush()
w(ESC + "?25l")  # hide cursor
def frame(footer, prompt=""):
    w(ESC + "H" + ESC + "J")
    w("\x1b[2m pi 0.84  ·  claude-opus-4.5  ·  ~/repos/app\x1b[0m\n\n")
    w("\x1b[36m>\x1b[0m " + prompt + "\n\n")
    w("\x1b[2m" + footer + "\x1b[0m\n")
frame("hold Space to dictate")
time.sleep(1.6)
frame("keep holding…")
time.sleep(0.6)
bars = "▁▂▃▄▅▆▇█"
import random
random.seed(3)
wave = []
for i in range(32):
    wave.append(random.choice([0,1,2,3,4,5,6,7,5,3,2,1]) if 4 < i < 28 else random.choice([0,0,1]))
    frame("\x1b[31m●\x1b[0m REC " + "".join(bars[v] for v in wave[-24:]))
    time.sleep(0.1)
frame("voice: transcribing…")
time.sleep(1.2)
frame("", "Refactoriza el parser de config y añade tests para los casos de error.")
time.sleep(3)
