# pi-voice-win

Hold Space on an empty prompt in [pi](https://github.com/badlogic/pi-mono), talk, let go. The text lands in the prompt. Same gesture as Claude Code's voice mode, but everything runs on your CPU. Windows only.

The model is NVIDIA's [Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) (int8, through sherpa-onnx). It picks the language on its own, 25 of them including Spanish and English, and writes punctuation and casing. On a Ryzen 5 2400G a 5 s phrase decodes in 1.3 s, the model loads in 3.4 s and uses about 1 GB of RAM. It also stays quiet on silence, which Whisper base never did.

Microphone capture goes through [decibri](https://www.npmjs.com/package/decibri) (WASAPI via cpal) at 16 kHz mono.

## Install

```sh
pi install git:github.com/axvg/pi-voice-win
```

The first session downloads the model (487 MB, 640 MB unpacked) into `~/.pi/models/` and unpacks it with Git's `tar`. The bz2 step takes a few minutes on this CPU. Progress shows in the footer. After that the extension is offline.

If `@juicesharp/rpiv-voice` is installed, remove it. Both register `/voice`.

## Use

| Action | Result |
| --- | --- |
| Hold Space on an empty prompt | footer shows `● REC ▃`. Release and the transcript is inserted |
| Tap Space | a space |
| `/voice` | start or stop recording by hand |
| `/voice devices` | list microphones |

How the hold works. Terminals don't report key-up, so the extension watches key-repeat. The first Space types a space, as usual. Once repeats arrive it deletes that space and opens the mic. When repeats stop for 350 ms it closes the mic and transcribes. Keep OS key-repeat on. In terminals that speak the kitty keyboard protocol (Windows Terminal 1.22+, WezTerm, Ghostty) pi receives a real key-up and recording stops at once.

While recording the footer shows a rolling waveform of the last 2.4 s. During the repeat warmup it says "keep holding…".

Words show up while you hold. Every second the current phrase is re-decoded and written to the prompt; once a phrase ends in 700 ms of silence it is committed and the next one starts. Decoding runs in a worker thread so the prompt never freezes. Set `"live": false` to decode only on release (then `"decode": "inline"` also becomes an option, which blocks the UI for about a quarter of the audio length).

## Config

Optional, at `~/.pi/agent/pi-voice-win.json`:

```json
{
  "model": "parakeet-v3",
  "decode": "worker",
  "live": true,
  "liveMs": 1000,
  "threads": 4,
  "device": "headset",
  "releaseMs": 350,
  "warmupRepeats": 2,
  "maxSec": 60
}
```

All keys optional.

`model` is `parakeet-v3` (default) or `canary-180m`. Canary is a third of the size and faster, covers en/es/de/fr, but cannot detect the language, so set `"language": "es"` with it.

`decode` is `worker` (default) or `inline`. `live` forces `worker`.

`live` shows partial text while holding. `liveMs` is how often the open phrase is re-decoded.

`threads` defaults to half the logical CPUs, at least 2. More than that gains little with int8 and starves pi while decoding.

`device` is a case-insensitive substring of the microphone name. `/voice devices` lists them. Default is the system input.

`maxSec` stops a recording on its own after that many seconds, in case the hold never releases. Default 60.

`releaseMs` is the gap between key-repeats that counts as a release. Raise it if recording cuts out mid sentence. Windows' slowest repeat rate is 500 ms.

`warmupRepeats` is how many repeats arrive before the mic opens. 2 means two quick taps on an empty prompt would start recording. Raise it if that bites you.

## Dev

```sh
npx tsx hold.ts                       # hold detector self-check
npx tsx bench.ts parakeet-v3 x.wav    # RTF on a wav file
npx tsx mic-test.ts 4                 # record 4 s from the default mic, print the transcript
pwsh -File e2e/hold-space.ps1         # launch pi, inject a held Space into its console, print the event log
```

`PI_VOICE_LOG=path` makes the extension append key and status events to a file. The e2e script uses it.
