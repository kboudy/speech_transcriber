#!/usr/bin/env bun
import chalk from "chalk";
import { readdir } from "node:fs/promises";
import dotenv from "dotenv";

dotenv.config({ path: import.meta.dir + "/../.env" });

const SAVE_DIR = process.env.SAVE_DIR || "";

if (!SAVE_DIR) {
  console.error(chalk.red("SAVE_DIR is not set in .env"));
  process.exit(1);
}

const entries = await readdir(SAVE_DIR).catch(() => [] as string[]);
const sessions = entries
  .filter((e) => /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(e))
  .sort()
  .reverse();

if (sessions.length === 0) {
  console.error(chalk.yellow("No sessions found in " + SAVE_DIR));
  process.exit(1);
}

const sessionDir = `${SAVE_DIR}/${sessions[0]}`;

const rawFile = Bun.file(`${sessionDir}/raw_transcription.txt`);
const cleanFile = Bun.file(`${sessionDir}/transcription.txt`);
const audioPath = `${sessionDir}/audio.wav`;

const rawText = await rawFile.exists() ? (await rawFile.text()).trim() : "(not found)";
const cleanText = await cleanFile.exists() ? (await cleanFile.text()).trim() : "(not found)";

console.log();
console.log(chalk.bold.dim("Session: ") + chalk.dim(sessions[0]));
console.log();
console.log(chalk.bold.yellow("Raw transcription:"));
console.log(chalk.yellow(rawText));
console.log();
console.log(chalk.bold.cyan("Cleaned transcription:"));
console.log(chalk.cyan(cleanText));
console.log();
console.log(chalk.bold.dim("Audio: ") + chalk.dim(audioPath));
console.log();
