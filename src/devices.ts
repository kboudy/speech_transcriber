#!/usr/bin/env bun
// Lists available audio input sources (microphones, not monitors)
// Usage: bun run devices

import { $ } from "bun";

const result = await $`pactl list sources short`.quiet().nothrow();

if (result.exitCode !== 0) {
  // Fallback to arecord for ALSA-only systems
  const alsa = await $`arecord -l`.quiet().nothrow();
  console.log(alsa.stdout.toString());
  process.exit(0);
}

const lines = result.stdout.toString().trim().split("\n");

console.log("Available input devices (set AUDIO_DEVICE in .env):\n");

for (const line of lines) {
  const [_index, name, _driver, _format, state] = line.split("\t");
  // Skip monitor sources (loopback of outputs) and show only real inputs
  if (name?.includes(".monitor")) continue;
  const active = state?.trim() === "RUNNING" ? " ← active" : "";
  console.log(`  ${name}${active}`);
}
