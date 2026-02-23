#!/usr/bin/env bun
/**
 * STT Daemon - persistent background process
 * Listens on a Unix socket for toggle commands from toggle.ts (called by sxhkd)
 *
 * States:
 *   idle       → receives "toggle" → starts recording
 *   recording  → receives "toggle" → stops, transcribes, cleans, types
 *   processing → ignores toggle (busy)
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

type State = "idle" | "recording" | "processing";

let state: State = "idle";
let recordingProcess: ReturnType<typeof Bun.spawn> | null = null;

// ─── Status bar ──────────────────────────────────────────────────────────────

async function setStatus(status: string) {
  await Bun.write(STATUS_FILE, status);
  console.log(`[STT] ${status}`);
  if (STATUS_BAR_PRINT_SCRIPT) {
    // Fire-and-forget: immediately refresh the full dwm status bar
    void $`${STATUS_BAR_PRINT_SCRIPT}`.quiet().text().then((bar) =>
      $`xsetroot -name ${bar.trim()}`.quiet().nothrow()
    ).catch(() => {});
  }
}

// ─── Audio recording ─────────────────────────────────────────────────────────

async function getRecordingCommand(): Promise<string[]> {
  // Prefer parecord (PipeWire/PulseAudio), fall back to arecord (ALSA)
  try {
    await $`which parecord`.quiet();
    const cmd = [
      "parecord",
      "--file-format=wav",
      "--channels=1",
      "--rate=16000",
      "--format=s16le",
    ];
    if (AUDIO_DEVICE) cmd.push(`--device=${AUDIO_DEVICE}`);
    cmd.push(AUDIO_FILE);
    return cmd;
  } catch {
    const cmd = ["arecord", "-f", "S16_LE", "-r", "16000", "-c", "1"];
    if (AUDIO_DEVICE) cmd.push("-D", AUDIO_DEVICE);
    cmd.push(AUDIO_FILE);
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

async function saveSession(audioFile: string, rawText: string, finalText: string) {
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

  // Stop recording
  recordingProcess?.kill("SIGTERM");
  recordingProcess = null;

  // Brief pause to ensure audio is fully flushed to disk
  await Bun.sleep(250);

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

async function handleMessage(msg: string) {
  const cmd = msg.trim();
  if (cmd === "toggle") {
    if (state === "idle") {
      await startRecording();
    } else if (state === "recording") {
      await stopAndProcess();
    } else {
      console.log("[STT] Busy, ignoring toggle");
    }
  } else if (cmd === "stop" && state === "recording") {
    await stopAndProcess();
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
console.log(`[STT] Bar:     ${STATUS_BAR_PRINT_SCRIPT || "(not set — bar won't auto-refresh)"}`);
