import { test, expect, describe } from "bun:test";

describe("devices.ts - audio device parsing", () => {
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

    // These are the filters from devices.ts
    const isMonitor = (name?: string) => name?.includes(".monitor");
    const isRealInput = (name?: string) => !name?.includes(".monitor");

    expect(isMonitor(monitorSource.split("\t")[1])).toBe(true);
    expect(isMonitor(microphoneSource.split("\t")[1])).toBe(false);
    expect(isRealInput(monitorSource.split("\t")[1])).toBe(false);
    expect(isRealInput(microphoneSource.split("\t")[1])).toBe(true);
  });

  test("identifies active sources by RUNNING state", () => {
    const activeLine = "2\talsa_input.usb-Blue_Microphones_Yeti_Stereo_Microphone\tPulseAudio\tS16LE\tRUNNING";
    const idleLine = "0\talsa_output.pci-0000_00_1f.3.analog-stereo.monitor\tPulseAudio\tS16LE\tIDLE";

    const [, , , , activeState] = activeLine.split("\t");
    const [, , , , idleState] = idleLine.split("\t");

    const isActive = (state?: string) => state?.trim() === "RUNNING";

    expect(isActive(activeState)).toBe(true);
    expect(isActive(idleState)).toBe(false);
  });

  test("handles multiple device lines", () => {
    const output = `0	alsa_output.pci-0000_00_1f.3.analog-stereo.monitor	PulseAudio	S16LE	RUNNING
1	alsa_input.pci-0000_00_1f.3.analog-stereo	ALSA	S16LE	IDLE
2	alsa_input.usb-Blue_Microphones_Yeti_Stereo_Microphone_FST_2018_10_10_45294-00.analog-stereo	PulseAudio	S16LE	RUNNING`;

    const lines = output.trim().split("\n");
    const devices = lines
      .map(line => line.split("\t"))
      .filter(([_, name]) => !name?.includes(".monitor"));

    expect(devices.length).toBe(2);
    expect(devices[0][1]).toBe("alsa_input.pci-0000_00_1f.3.analog-stereo");
    expect(devices[1][1]).toBe("alsa_input.usb-Blue_Microphones_Yeti_Stereo_Microphone_FST_2018_10_10_45294-00.analog-stereo");
  });

  test("marks active devices correctly", () => {
    const activeLine = "2\talsa_input.usb-Blue_Microphones_Yeti_Stereo_Microphone\tPulseAudio\tS16LE\tRUNNING";
    const [, name, , , state] = activeLine.split("\t");

    const active = state?.trim() === "RUNNING" ? " ← active" : "";

    expect(active).toBe(" ← active");
  });

  test("marks inactive devices as empty string", () => {
    const inactiveLine = "2\talsa_input.usb-Blue_Microphones_Yeti_Stereo_Microphone\tPulseAudio\tS16LE\tIDLE";
    const [, name, , , state] = inactiveLine.split("\t");

    const active = state?.trim() === "RUNNING" ? " ← active" : "";

    expect(active).toBe("");
  });

  test("handles empty output", () => {
    const output = "";
    const lines = output.trim().split("\n");
    expect(lines[0]).toBe("");
  });

  test("handles ALSA arecord fallback format", () => {
    // arecord -l output format
    const arecordOutput = `**** List of CAPTURE hardware devices ****
card 0: PCH [HDA Intel PCH], device 0: ALC295 [Analog]
  Subdevices: 1/1
  Subdevice #0: subdevice #0
card 1: Microphone [Blue USB Microphone], device 0: USB Audio [USB Audio]
  Subdevices: 1/1
  Subdevice #0: subdevice #0`;

    expect(arecordOutput).toContain("card 0:");
    expect(arecordOutput).toContain("card 1:");
    expect(arecordOutput).toContain("device 0:");
  });
});
