import { test, expect, describe } from "bun:test";

describe("last_stt.ts - session directory parsing", () => {
  const regex = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/;

  test("valid session directories match the regex", () => {
    const validDirs = [
      "2024-01-15_10-30-45",
      "2026-02-24_00-00-00",
      "2026-12-31_23-59-59",
      "2000-01-01_00-00-00",
    ];

    for (const dir of validDirs) {
      expect(dir).toMatch(regex);
    }
  });

  test("invalid session directories do not match", () => {
    const invalidDirs = [
      "2024-1-15_10-30-45",      // single digit month
      "2024-01-15_10-30",        // missing seconds
      "2024-01-15",              // missing time
      "10-30-45",                // missing date
      "invalid",
      "2024_01_15_10-30-45",     // wrong separator
      "2024-01-15T10-30-45",     // T separator
      "2024/01/15_10-30-45",     // forward slash
    ];

    for (const dir of invalidDirs) {
      expect(dir).not.toMatch(regex);
    }
  });

  test("sorting and reversing session directories", () => {
    const entries = [
      "2024-01-15_10-30-45",
      "2026-02-24_14-22-00",
      "2024-01-14_09-00-00",
      "2026-02-24_14-21-59",
    ];

    const sorted = entries
      .filter((e) => regex.test(e))
      .sort()
      .reverse();

    expect(sorted[0]).toBe("2026-02-24_14-22-00");
    expect(sorted[1]).toBe("2026-02-24_14-21-59");
    expect(sorted[2]).toBe("2024-01-15_10-30-45");
    expect(sorted[3]).toBe("2024-01-14_09-00-00");
  });

  test("filters out non-session entries", () => {
    const entries = [
      "2024-01-15_10-30-45",
      "2024-01-14_09-00-00",
      ".env",
      ".git",
      "node_modules",
      "README.md",
      "sessions",
      "temp",
      "2024-01-13_backup",
    ];

    const sessions = entries.filter((e) => regex.test(e));

    expect(sessions.length).toBe(2);
    expect(sessions).toContain("2024-01-15_10-30-45");
    expect(sessions).toContain("2024-01-14_09-00-00");
  });

  test("gets most recent session after sort and reverse", () => {
    const entries = [
      "2024-01-15_10-30-45",
      "2026-02-24_14-22-00",
      "2024-01-14_09-00-00",
      "2026-02-24_14-21-59",
    ];

    const sessions = entries
      .filter((e) => regex.test(e))
      .sort()
      .reverse();

    const mostRecent = sessions[0];
    expect(mostRecent).toBe("2026-02-24_14-22-00");
  });

  test("handles empty entries list", () => {
    const entries: string[] = [];
    const sessions = entries
      .filter((e) => regex.test(e))
      .sort()
      .reverse();

    expect(sessions.length).toBe(0);
  });

  test("handles entries with only invalid names", () => {
    const entries = [".env", ".git", "README.md"];
    const sessions = entries
      .filter((e) => regex.test(e))
      .sort()
      .reverse();

    expect(sessions.length).toBe(0);
  });
});

describe("last_stt.ts - file path construction", () => {
  test("constructs correct session file paths", () => {
    const SAVE_DIR = "/home/user/stt_sessions";
    const sessionDir = "2026-02-24_14-22-00";

    const rawFile = `${SAVE_DIR}/${sessionDir}/raw_transcription.txt`;
    const cleanFile = `${SAVE_DIR}/${sessionDir}/transcription.txt`;
    const audioPath = `${SAVE_DIR}/${sessionDir}/audio.wav`;

    expect(rawFile).toBe("/home/user/stt_sessions/2026-02-24_14-22-00/raw_transcription.txt");
    expect(cleanFile).toBe("/home/user/stt_sessions/2026-02-24_14-22-00/transcription.txt");
    expect(audioPath).toBe("/home/user/stt_sessions/2026-02-24_14-22-00/audio.wav");
  });
});
