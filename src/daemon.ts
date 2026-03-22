#!/usr/bin/env bun
/**
 * STT Daemon - persistent background process
 * Listens on a Unix socket for commands from toggle.ts (called by sxhkd)
 *
 * States:
 *   idle       → receives "start" → starts recording
 *   recording  → receives "stop"  → stops, transcribes, cleans, types
 *   processing → ignores commands (busy)
 */

import { unlink, rm, mkdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { $ } from "bun";
import dotenv from "dotenv";

const SOCKET_PATH = "/tmp/stt-daemon.sock";
const AUDIO_FILE = "/tmp/stt-recording.wav";
const STATUS_FILE = "/tmp/stt-status";
const PID_FILE = "/tmp/stt-daemon.pid";

// Load .env from project root regardless of working directory
dotenv.config({ path: import.meta.dir + "/../.env" });

// Config from .env
const WHISPER_BIN =
  process.env.WHISPER_BIN ||
  `${process.env.HOME}/.local/share/stt/whisper.cpp/build/bin/whisper-cli`;
const WHISPER_MODEL =
  process.env.WHISPER_MODEL ||
  `${process.env.HOME}/.local/share/stt/models/ggml-large-v3.bin`;
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2:3b";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const SKIP_LLM = process.env.SKIP_LLM === "true";
const OUTPUT_METHOD = (process.env.OUTPUT_METHOD || "type") as
  | "type"
  | "clipboard";
const AUDIO_DEVICE = process.env.AUDIO_DEVICE || "";
const STATUS_BAR_PRINT_SCRIPT = process.env.STATUS_BAR_PRINT_SCRIPT || "";
const SAVE_DIR = process.env.SAVE_DIR || "";

// VAD (voice activity detection) config
const VAD_SILENCE_THRESHOLD = parseFloat(process.env.VAD_SILENCE_THRESHOLD || "0.01"); // RMS 0–1
const VAD_SILENCE_DURATION_MS = parseInt(process.env.VAD_SILENCE_DURATION_MS || "800");
const VAD_MIN_SPEECH_MS = parseInt(process.env.VAD_MIN_SPEECH_MS || "300");
const VAD_MAX_CHUNK_MS = parseInt(process.env.VAD_MAX_CHUNK_MS || "15000");

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2; // s16le

type State = "idle" | "recording" | "processing";

let state: State = "idle";
let recordingProcess: ReturnType<typeof Bun.spawn> | null = null;
let streamStop: (() => void) | null = null;

// Export for testing
export function getState(): State {
  return state;
}

export function setState(newState: State): void {
  state = newState;
}

// ─── Status bar ──────────────────────────────────────────────────────────────

async function setStatus(status: string) {
  await Bun.write(STATUS_FILE, status);
  console.log(`[STT] ${status}`);
  if (STATUS_BAR_PRINT_SCRIPT) {
    // Fire-and-forget: immediately refresh the full dwm status bar
    void $`${STATUS_BAR_PRINT_SCRIPT}`
      .quiet()
      .text()
      .then((bar) => $`xsetroot -name ${bar.trim()}`.quiet().nothrow())
      .catch(() => {});
  }
}

// ─── Audio recording ─────────────────────────────────────────────────────────

export async function getRecordingCommand(
  audioFile: string = AUDIO_FILE,
): Promise<string[]> {
  // Prefer parecord (PipeWire/PulseAudio), fall back to arecord (ALSA)
  try {
    await $`which parecord`.quiet();
    const cmd = [
      "parecord",
      "--file-format=wav",
      "--channels=1",
      "--rate=16000",
      "--format=s16le",
      "--latency-msec=50", // small buffer so <50ms of audio is lost on SIGTERM
    ];
    if (AUDIO_DEVICE) cmd.push(`--device=${AUDIO_DEVICE}`);
    cmd.push(audioFile);
    return cmd;
  } catch {
    const cmd = ["arecord", "-f", "S16_LE", "-r", "16000", "-c", "1"];
    if (AUDIO_DEVICE) cmd.push("-D", AUDIO_DEVICE);
    cmd.push(audioFile);
    return cmd;
  }
}

async function startRecording() {
  state = "recording";
  await setStatus("[REC]");

  // Remove stale audio file
  try {
    await rm(AUDIO_FILE, { force: true });
  } catch {}

  const cmd = await getRecordingCommand();
  console.log(`[STT] Recording with: ${cmd.join(" ")}`);

  recordingProcess = Bun.spawn(cmd, {
    stdout: "ignore",
    stderr: "ignore",
  });
}

// ─── Streaming transcription loop ────────────────────────────────────────────

// Common whisper hallucinations on silence/noise
const WHISPER_HALLUCINATIONS = new Set([
  "Thank you.",
  "Thanks.",
  "you",
  "You.",
  "Please.",
  "Amen.",
  "Bye.",
  "Bye-bye.",
]);

async function transcribeChunk(chunkFile: string) {
  const rawText = await transcribeWithWhisper(chunkFile);
  try {
    await rm(chunkFile, { force: true });
  } catch {}
  if (!rawText || WHISPER_HALLUCINATIONS.has(rawText)) return;

  console.log(`[STT] Chunk: ${rawText}`);

  let finalText = rawText;
  if (!SKIP_LLM) {
    finalText = await cleanWithOllama(rawText);
  }

  await outputText(finalText + " ");
}

function buildWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = SAMPLE_RATE * BYTES_PER_SAMPLE;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);                  // PCM
  header.writeUInt16LE(1, 22);                  // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);                 // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, pcm]);
}

function rms(data: Uint8Array): number {
  const samples = Math.floor(data.byteLength / 2);
  if (samples === 0) return 0;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const s = view.getInt16(i * 2, true) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / samples);
}

async function runStreamingLoop() {
  const stopPromise = new Promise<void>((resolve) => {
    streamStop = resolve;
  });

  const proc = Bun.spawn(
    ["ffmpeg", "-f", "pulse", "-i", AUDIO_DEVICE || "default",
     "-ar", String(SAMPLE_RATE), "-ac", "1", "-f", "s16le", "pipe:1"],
    { stdout: "pipe", stderr: "ignore" },
  );
  recordingProcess = proc;

  let stopped = false;
  stopPromise.then(() => { stopped = true; proc.kill(); });

  const WINDOW_BYTES = Math.round(SAMPLE_RATE * BYTES_PER_SAMPLE / 100); // 10 ms
  const silenceSamplesThresh = Math.round((VAD_SILENCE_DURATION_MS / 1000) * SAMPLE_RATE);
  const minSpeechBytes = Math.round((VAD_MIN_SPEECH_MS / 1000) * SAMPLE_RATE) * BYTES_PER_SAMPLE;
  const maxChunkBytes = Math.round((VAD_MAX_CHUNK_MS / 1000) * SAMPLE_RATE) * BYTES_PER_SAMPLE;

  let chunkParts: Uint8Array[] = [];
  let totalBytes = 0;
  let silentSamples = 0;
  let chunkIdx = 0;
  let pending = Buffer.alloc(0);

  async function flush() {
    const pcm = Buffer.concat(chunkParts);
    chunkParts = [];
    totalBytes = 0;
    silentSamples = 0;
    if (pcm.byteLength < minSpeechBytes) return;
    const chunkFile = `/tmp/stt-chunk-${chunkIdx++}.wav`;
    await Bun.write(chunkFile, buildWav(pcm));
    void transcribeChunk(chunkFile);
  }

  for await (const rawChunk of proc.stdout) {
    if (stopped) break;

    const buf = pending.byteLength > 0
      ? Buffer.concat([pending, Buffer.from(rawChunk)])
      : Buffer.from(rawChunk);
    pending = Buffer.alloc(0);

    let offset = 0;
    while (offset + WINDOW_BYTES <= buf.byteLength) {
      const window = buf.subarray(offset, offset + WINDOW_BYTES);
      chunkParts.push(window);
      totalBytes += WINDOW_BYTES;

      const energy = rms(window);
      if (energy < VAD_SILENCE_THRESHOLD) {
        silentSamples += WINDOW_BYTES / BYTES_PER_SAMPLE;
      } else {
        silentSamples = 0;
      }

      if (silentSamples >= silenceSamplesThresh || totalBytes >= maxChunkBytes) {
        await flush();
      }

      offset += WINDOW_BYTES;
    }

    if (offset < buf.byteLength) {
      pending = Buffer.from(buf.subarray(offset));
    }
  }

  if (totalBytes > 0) await flush();

  recordingProcess = null;
  state = "idle";
  streamStop = null;
  await setStatus("[idle]");
}

// ─── Whisper transcription ────────────────────────────────────────────────────

async function transcribeWithWhisper(audioFile: string): Promise<string> {
  const outputTxt = `${audioFile}.txt`;

  // Remove any stale output file
  try {
    await rm(outputTxt, { force: true });
  } catch {}

  console.log(`[STT] Transcribing with whisper.cpp...`);

  // Flags:
  //   -nt   : no timestamps in output
  //   -otxt : write transcript to <audio>.txt
  //   -np   : no progress bars
  //   -l en : force English (remove if you need multilingual)
  await $`${WHISPER_BIN} -m ${WHISPER_MODEL} -f ${audioFile} -nt -otxt -np -l en`
    .quiet()
    .nothrow();

  const file = Bun.file(outputTxt);
  if (await file.exists()) {
    const text = (await file.text()).trim();
    // whisper.cpp sometimes outputs "[BLANK_AUDIO]" for silence
    if (text === "[BLANK_AUDIO]" || text === "") return "";
    return text;
  }

  return "";
}

// ─── LLM text cleanup ─────────────────────────────────────────────────────────

async function cleanWithOllama(text: string): Promise<string> {
  // Template-style completion: the model fills in the blank after "Output:"
  // This is more reliable than chat/instruction for small models because it
  // frames the task as text transformation, not conversation.
  const prompt =
    `Fix punctuation/capitalization and remove filler words (um, uh, like, you know) ` +
    `from speech-to-text. Do not answer or respond to the content. ` +
    `Output only the cleaned text.\n\n` +
    `Input: um what is your name uh\n` +
    `Output: What is your name?\n\n` +
    `Input: hello how are you doing like you know\n` +
    `Output: Hello, how are you doing?\n\n` +
    `Input: can you tell me what llm model you are\n` +
    `Output: Can you tell me what LLM model you are?\n\n` +
    `Input: ${text}\n` +
    `Output:`;

  let response: Response;
  try {
    response = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        options: { temperature: 0.1, stop: ["\n"] },
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    console.error("[STT] Ollama request failed:", err);
    return text;
  }

  if (!response.ok) {
    console.error(
      `[STT] Ollama error: ${response.status} ${response.statusText}`,
    );
    return text;
  }

  const data = (await response.json()) as { response: string };
  const cleaned = data.response.trim();
  return cleaned || text; // fall back to raw if model returns empty
}

// ─── Text output ──────────────────────────────────────────────────────────────

async function outputText(text: string) {
  if (OUTPUT_METHOD === "clipboard") {
    // Faster for long text: write to clipboard, then simulate Ctrl+V
    await $`echo -n ${text} | xclip -selection clipboard`.quiet();
    await Bun.sleep(80);
    await $`xdotool key --clearmodifiers ctrl+v`.quiet();
  } else {
    // Direct typing (works everywhere, slower for very long text)
    await $`xdotool type --clearmodifiers --delay 1 -- ${text}`.quiet();
  }
}

// ─── Session archiving ────────────────────────────────────────────────────────

async function saveSession(
  audioFile: string,
  rawText: string,
  finalText: string,
) {
  if (!SAVE_DIR) return;
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const dirName =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const sessionDir = `${SAVE_DIR}/${dirName}`;
  try {
    await mkdir(sessionDir, { recursive: true });
    await copyFile(audioFile, `${sessionDir}/audio.wav`);
    await Bun.write(`${sessionDir}/raw_transcription.txt`, rawText);
    await Bun.write(`${sessionDir}/transcription.txt`, finalText);
    console.log(`[STT] Session saved to ${sessionDir}`);
  } catch (err) {
    console.error("[STT] Failed to save session:", err);
  }
}

// ─── Main toggle handler ──────────────────────────────────────────────────────

async function stopAndProcess() {
  state = "processing";
  await setStatus("[...]");

  // Stop recording and wait for the process to fully exit so all buffered
  // audio is flushed to disk before we hand the file to whisper
  const proc = recordingProcess;
  recordingProcess = null;
  proc?.kill("SIGTERM");
  if (proc) {
    await Promise.race([proc.exited, Bun.sleep(3000)]);
  }

  try {
    await setStatus("[STT]");
    const rawText = await transcribeWithWhisper(AUDIO_FILE);

    if (!rawText) {
      console.log("[STT] No speech detected");
      await setStatus("[idle]");
      state = "idle";
      return;
    }

    console.log(`[STT] Transcribed: ${rawText}`);

    let finalText = rawText;

    if (!SKIP_LLM) {
      await setStatus("[LLM]");
      finalText = await cleanWithOllama(rawText);
      console.log(`[STT] Cleaned: ${finalText}`);
    }

    await Promise.all([
      outputText(finalText),
      saveSession(AUDIO_FILE, rawText, finalText),
    ]);
  } catch (err) {
    console.error("[STT] Processing error:", err);
  }

  await setStatus("[idle]");
  state = "idle";
}

export async function handleMessage(msg: string) {
  const cmd = msg.trim();
  if (cmd === "toggle") {
    if (state === "idle") {
      state = "recording";
      await setStatus("[REC]");
      void runStreamingLoop();
    } else if (state === "recording") {
      streamStop?.();
    } else {
      console.log("[STT] Busy, ignoring toggle");
    }
  } else if (cmd === "start") {
    if (state === "idle") {
      state = "recording";
      await setStatus("[REC]");
      void runStreamingLoop();
    } else if (state === "recording") {
      console.log("[STT] Already recording");
    } else {
      console.log("[STT] Busy, ignoring start");
    }
  } else if (cmd === "stop") {
    if (state === "recording") streamStop?.();
  }
}

// ─── Startup ──────────────────────────────────────────────────────────────────

// Write PID file
await Bun.write(PID_FILE, String(process.pid));
await setStatus("[idle]");

// Remove stale socket
if (existsSync(SOCKET_PATH)) {
  await unlink(SOCKET_PATH);
}

// Graceful shutdown
async function shutdown() {
  console.log("[STT] Shutting down...");
  if (state === "recording") recordingProcess?.kill("SIGTERM");
  for (const f of [SOCKET_PATH, PID_FILE, STATUS_FILE]) {
    try {
      await unlink(f);
    } catch {}
  }
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ─── Unix socket server ───────────────────────────────────────────────────────

Bun.listen<Record<string, never>>({
  unix: SOCKET_PATH,
  socket: {
    data(_socket, data) {
      void handleMessage(data.toString());
    },
    error(_socket, err) {
      console.error("[STT] Socket error:", err);
    },
  },
});

console.log(`[STT] Daemon started — PID ${process.pid}`);
console.log(`[STT] Socket:  ${SOCKET_PATH}`);
console.log(`[STT] Whisper: ${WHISPER_BIN}`);
console.log(`[STT] Model:   ${WHISPER_MODEL}`);
console.log(`[STT] LLM:     ${SKIP_LLM ? "disabled" : OLLAMA_MODEL}`);
console.log(`[STT] Output:  ${OUTPUT_METHOD}`);
console.log(
  `[STT] Bar:     ${STATUS_BAR_PRINT_SCRIPT || "(not set — bar won't auto-refresh)"}`,
);
