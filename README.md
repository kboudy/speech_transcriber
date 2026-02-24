# Speech-to-Text for dwm

Global hotkey speech-to-text for Linux/dwm. Press the hotkey to start recording,
press again to stop — the transcribed (and LLM-cleaned) text is typed into whatever
window is focused.

**Stack:** whisper.cpp (CUDA) + Ollama (llama3.2:3b) + sxhkd + Bun/TypeScript

Reference: https://www.reddit.com/r/LocalLLaMA/comments/1qr8vbn/shockingly_fast_local_speechtotext_llm_cleanup_on/

## Setup

```bash
bun run setup
```

**Prerequisites:**

- [Ollama](https://ollama.com/download) installed and running
- Bun installed
- NVIDIA driver installed (`nvidia-smi` should work)

The setup script will:

1. Install system dependencies (`xdotool`, `sxhkd`, `parecord`/`arecord`, `nvidia-cuda-toolkit`)
2. Clone and build `whisper.cpp` with CUDA GPU support
3. Download the `large-v3` Whisper model (~3GB)
4. Pull `llama3.2:3b` via Ollama
5. Install the sxhkd hotkey binding
6. Install a systemd user service

If you already have `nvidia-cuda-toolkit` installed, step 1 will skip it.

## Usage

**Start the daemon:**

```bash
systemctl --user start stt-daemon
# or manually:
bun run daemon
```

**Hotkey:** `Super + grave` (backtick) — toggles recording on/off

### Auto-start with dwm

Add these lines to `~/.xinitrc` before the `exec dwm` line:

```bash
sxhkd &
/home/keith/.bun/bin/bun run --cwd /home/keith/keith_apps/speech_transcriber daemon &
```

**Change the hotkey:** edit [config/sxhkdrc](config/sxhkdrc), then `pkill -USR1 sxhkd`

## Configuration

Copy `.env.example` to `.env` and edit:

| Variable                  | Default                                                | Description                                               |
| ------------------------- | ------------------------------------------------------ | --------------------------------------------------------- |
| `WHISPER_BIN`             | `~/.local/share/stt/whisper.cpp/build/bin/whisper-cli` | Path to whisper.cpp binary                                |
| `WHISPER_MODEL`           | `~/.local/share/stt/models/ggml-large-v3.bin`          | Whisper model file                                        |
| `OLLAMA_MODEL`            | `llama3.2:3b`                                          | Ollama model for text cleanup                             |
| `OLLAMA_URL`              | `http://localhost:11434`                               | Ollama API base URL                                       |
| `SKIP_LLM`                | `false`                                                | Set to `true` to skip LLM cleanup                         |
| `OUTPUT_METHOD`           | `type`                                                 | `type` (xdotool) or `clipboard` (Ctrl+V)                  |
| `AUDIO_DEVICE`            | _(system default)_                                     | Specific mic device (parecord `--device` or arecord `-D`) |
| `SAVE_DIR`                | _(unset)_                                              | Directory to archive sessions (see below)                 |
| `STATUS_BAR_PRINT_SCRIPT` | _(unset)_                                              | Script to run after status changes (e.g. dwm bar refresh) |

## Session archiving

Set `SAVE_DIR` to a directory and each recording will be saved there in a timestamped subdirectory:

```
$SAVE_DIR/
└── 2026-02-23_14-30-45/
    ├── audio.wav              # raw recording
    ├── raw_transcription.txt  # whisper output before LLM cleanup
    └── transcription.txt      # final text typed into the window
```

To inspect the most recent session:

```bash
bun run last_stt
```

This prints the raw and cleaned transcriptions in colour, and the path to the audio file.

## Status bar (dwm)

The daemon writes its current state to `/tmp/stt-status`. Add to your dwm status script:

```bash
stt=$(cat /tmp/stt-status 2>/dev/null)
[[ -n "$stt" ]] && echo " $stt"
```

States: `[idle]` `[REC]` `[STT]` `[LLM]` `[...]`

## Logs

```bash
journalctl --user -fu stt-daemon
```
