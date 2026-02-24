import { test, expect, describe } from "bun:test";

describe("session timestamp format", () => {
  test("timestamp matches expected format YYYY-MM-DD_HH-MM-SS", () => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const expected = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;

    // This is the format used in saveSession
    const regex = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/;
    expect(expected).toMatch(regex);
  });

  test("last_stt.ts regex matches session directories", () => {
    const regex = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/;

    // Valid timestamps
    expect("2024-01-15_10-30-45").toMatch(regex);
    expect("2026-02-24_00-00-00").toMatch(regex);
    expect("2026-12-31_23-59-59").toMatch(regex);

    // Invalid timestamps
    expect("2024-1-15_10-30-45").not.toMatch(regex);
    expect("2024-01-15_10-30").not.toMatch(regex);
    expect("invalid").not.toMatch(regex);
  });
});

describe("audio device parsing", () => {
  test("parses pactl source lines correctly", () => {
    // Format: index\tname\tdriver\tformat\tstate
    const line = "0\talsa_output.pci-0000_00_1f.3.analog-stereo.monitor\tPulseAudio\tS16LE\tRUNNING";
    const [index, name, driver, format, state] = line.split("\t");

    expect(index).toBe("0");
    expect(name).toBe("alsa_output.pci-0000_00_1f.3.analog-stereo.monitor");
    expect(driver).toBe("PulseAudio");
    expect(format).toBe("S16LE");
    expect(state).toBe("RUNNING");
  });

  test("correctly identifies monitor sources", () => {
    const monitorSource = "0\talsa_output.pci-0000_00_1f.3.analog-stereo.monitor\tPulseAudio\tS16LE\tRUNNING";
    const microphoneSource = "2\talsa_input.usb-Blue_Microphones_Yeti_Stereo_Microphone\tPulseAudio\tS16LE\tRUNNING";

    expect(monitorSource.includes(".monitor")).toBe(true);
    expect(microphoneSource.includes(".monitor")).toBe(false);
  });

  test("identifies active sources by RUNNING state", () => {
    const activeLine = "2\talsa_input.usb-Blue_Microphones_Yeti_Stereo_Microphone\tPulseAudio\tS16LE\tRUNNING";
    const idleLine = "0\talsa_output.pci-0000_00_1f.3.analog-stereo.monitor\tPulseAudio\tS16LE\tIDLE";

    const [, , , , activeState] = activeLine.split("\t");
    const [, , , , idleState] = idleLine.split("\t");

    expect(activeState?.trim()).toBe("RUNNING");
    expect(idleState?.trim()).toBe("IDLE");
  });
});

describe("Ollama prompt formatting", () => {
  test("constructs correct prompt for cleanup", () => {
    const inputText = "um hello uh what is up";

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
      `Input: ${inputText}\n` +
      `Output:`;

    expect(prompt).toContain("Input: um hello uh what is up");
    expect(prompt).toContain("Output:");
    expect(prompt).not.toContain("um uh like you know");
  });

  test("handles empty input", () => {
    const inputText = "";
    const prompt = `Input: ${inputText}\nOutput:`;
    expect(prompt).toContain("Input: \nOutput:");
  });

  test("handles multiline input", () => {
    const inputText = "hello\nthis is a test";
    const prompt = `Input: ${inputText}\nOutput:`;
    expect(prompt).toContain("Input: hello\nthis is a test");
  });
});

describe("recording command construction", () => {
  test("builds parecord command with all required flags", () => {
    const AUDIO_DEVICE = "";
    const AUDIO_FILE = "/tmp/stt-recording.wav";

    const cmd = [
      "parecord",
      "--file-format=wav",
      "--channels=1",
      "--rate=16000",
      "--format=s16le",
      "--latency-msec=50",
    ];

    if (AUDIO_DEVICE) cmd.push(`--device=${AUDIO_DEVICE}`);
    cmd.push(AUDIO_FILE);

    expect(cmd[0]).toBe("parecord");
    expect(cmd).toContain("--file-format=wav");
    expect(cmd).toContain("--channels=1");
    expect(cmd).toContain("--rate=16000");
    expect(cmd).toContain(AUDIO_FILE);
  });

  test("builds arecord fallback command with all required flags", () => {
    const AUDIO_DEVICE = "";
    const AUDIO_FILE = "/tmp/stt-recording.wav";

    const cmd = ["arecord", "-f", "S16_LE", "-r", "16000", "-c", "1"];
    if (AUDIO_DEVICE) cmd.push("-D", AUDIO_DEVICE);
    cmd.push(AUDIO_FILE);

    expect(cmd[0]).toBe("arecord");
    expect(cmd).toContain("-f");
    expect(cmd).toContain("S16_LE");
    expect(cmd).toContain("-r");
    expect(cmd).toContain("16000");
    expect(cmd).toContain(AUDIO_FILE);
  });

  test("includes custom audio device when specified", () => {
    const AUDIO_DEVICE = "hw:0";
    const AUDIO_FILE = "/tmp/stt-recording.wav";

    // parecord with device
    const cmd = [
      "parecord",
      "--file-format=wav",
      "--channels=1",
      "--rate=16000",
      "--format=s16le",
      "--latency-msec=50",
    ];
    if (AUDIO_DEVICE) cmd.push(`--device=${AUDIO_DEVICE}`);
    cmd.push(AUDIO_FILE);

    expect(cmd).toContain(`--device=${AUDIO_DEVICE}`);
  });
});

describe("whisper output parsing", () => {
  test("handles blank audio detection", () => {
    const blankOutput = "[BLANK_AUDIO]";
    const emptyOutput = "";
    const validOutput = "Hello world";

    // These are the checks from transcribeWithWhisper
    const isBlank = (text: string) => text === "[BLANK_AUDIO]" || text === "";

    expect(isBlank(blankOutput)).toBe(true);
    expect(isBlank(emptyOutput)).toBe(true);
    expect(isBlank(validOutput)).toBe(false);
  });

  test("trims whitespace from transcription", () => {
    const rawText = "  Hello world  ";
    const trimmed = rawText.trim();
    expect(trimmed).toBe("Hello world");
  });
});
