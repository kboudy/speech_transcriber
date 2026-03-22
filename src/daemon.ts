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

import { unlink, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { $ } from "bun";
import dotenv from "dotenv";

const SOCKET_PATH = "/tmp/stt-daemon.sock";
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
const WHISPER_SERVER_URL = process.env.WHISPER_SERVER_URL || "";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2:3b";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const SKIP_LLM = process.env.SKIP_LLM === "true";
const OUTPUT_METHOD = (process.env.OUTPUT_METHOD || "type") as
  | "type"
  | "clipboard";
const AUDIO_DEVICE = process.env.AUDIO_DEVICE || "";
const STATUS_BAR_PRINT_SCRIPT = process.env.STATUS_BAR_PRINT_SCRIPT || "";

// VAD (voice activity detection) config
const VAD_START_THRESHOLD_PCT = process.env.VAD_START_THRESHOLD_PCT || "1%";  // begin chunk when audio exceeds this
const VAD_SILENCE_THRESHOLD_PCT = process.env.VAD_SILENCE_THRESHOLD_PCT || "3%"; // end chunk after this much silence
const VAD_SILENCE_DURATION_MS = parseInt(process.env.VAD_SILENCE_DURATION_MS || "800");
const VAD_MAX_CHUNK_MS = parseInt(process.env.VAD_MAX_CHUNK_MS || "15000");

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

async function startWhisperServer() {
  await $`systemctl --user start whisper-server.service`.quiet().nothrow();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${WHISPER_SERVER_URL}/`, { signal: AbortSignal.timeout(500) });
      if (res.status < 500) return;
    } catch {}
    await Bun.sleep(200);
  }
  console.warn("[STT] whisper-server did not become ready in time");
}

async function stopWhisperServer() {
  await $`systemctl --user stop whisper-server.service`.quiet().nothrow();
}

async function runStreamingLoop() {
  if (WHISPER_SERVER_URL) {
    await setStatus("[...]");
    await startWhisperServer();
  }
  await setStatus("[REC]");

  const stopPromise = new Promise<void>((resolve) => {
    streamStop = resolve;
  });

  const silenceDuration = (VAD_SILENCE_DURATION_MS / 1000).toFixed(2);
  let chunkIdx = 0;

  while (true) {
    const chunkFile = `/tmp/stt-chunk-${chunkIdx++}.wav`;
    const proc = Bun.spawn([
      "sox", "-t", "pulseaudio", AUDIO_DEVICE || "default",
      "-r", "16000", "-c", "1",
      chunkFile,
      "silence", "1", "0.05", VAD_START_THRESHOLD_PCT,
                "1", silenceDuration, VAD_SILENCE_THRESHOLD_PCT,
    ], { stdout: "ignore", stderr: "ignore" });
    recordingProcess = proc;

    const result = await Promise.race([
      proc.exited.then(() => "done" as const),
      stopPromise.then(() => "stop" as const),
      Bun.sleep(VAD_MAX_CHUNK_MS).then(() => "timeout" as const),
    ]);

    if (proc.exitCode === null) proc.kill("SIGTERM");
    recordingProcess = null;
    await Promise.race([proc.exited, Bun.sleep(500)]);

    void transcribeChunk(chunkFile);

    if (result === "stop") break;
  }

  state = "idle";
  streamStop = null;
  if (WHISPER_SERVER_URL) await stopWhisperServer();
  await setStatus("[idle]");
}

// ─── Whisper transcription ────────────────────────────────────────────────────

async function transcribeWithWhisper(audioFile: string): Promise<string> {
  console.log(`[STT] Transcribing with whisper.cpp...`);
  if (WHISPER_SERVER_URL) {
    return transcribeViaServer(audioFile);
  }
  return transcribeViaCLI(audioFile);
}

async function transcribeViaServer(audioFile: string): Promise<string> {
  const file = Bun.file(audioFile);
  if (!await file.exists()) return "";

  const formData = new FormData();
  const blob = new Blob([await file.arrayBuffer()], { type: "audio/wav" });
  formData.append("file", blob, "audio.wav");
  formData.append("language", "en");
  formData.append("response_format", "json");

  let response: Response;
  try {
    response = await fetch(`${WHISPER_SERVER_URL}/inference`, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    console.error("[STT] whisper-server request failed:", err);
    return "";
  }

  if (!response.ok) {
    console.error(`[STT] whisper-server error: ${response.status} ${response.statusText}`);
    return "";
  }

  const data = await response.json() as { text: string };
  const text = data.text?.trim() ?? "";
  if (text === "[BLANK_AUDIO]" || text === "") return "";
  return text;
}

async function transcribeViaCLI(audioFile: string): Promise<string> {
  const outputTxt = `${audioFile}.txt`;

  try {
    await rm(outputTxt, { force: true });
  } catch {}

  // Flags: -nt no timestamps, -otxt write to <audio>.txt, -np no progress, -l en force English
  await $`${WHISPER_BIN} -m ${WHISPER_MODEL} -f ${audioFile} -nt -otxt -np -l en`
    .quiet()
    .nothrow();

  const file = Bun.file(outputTxt);
  if (await file.exists()) {
    const text = (await file.text()).trim();
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

// ─── Main toggle handler ──────────────────────────────────────────────────────

export async function handleMessage(msg: string) {
  const cmd = msg.trim();
  if (cmd === "toggle") {
    if (state === "idle") {
      state = "recording";
      void runStreamingLoop();
    } else if (state === "recording") {
      streamStop?.();
    } else {
      console.log("[STT] Busy, ignoring toggle");
    }
  } else if (cmd === "start") {
    if (state === "idle") {
      state = "recording";
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
