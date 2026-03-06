#!/usr/bin/env bun
/**
 * Toggle script — called by sxhkd on hotkey press/release.
 * Connects to the daemon's Unix socket and sends "start" or "stop".
 */

const SOCKET_PATH = "/tmp/stt-daemon.sock";

const cmd = process.argv[2] || "toggle";

const socket = await Bun.connect({
  unix: SOCKET_PATH,
  socket: {
    data() {},
    error(_socket, err) {
      console.error("[STT] Socket error:", err);
      process.exit(1);
    },
    connectError(_socket, err) {
      console.error(
        "[STT] Daemon not running. Start it with:\n  bun run daemon"
      );
      process.exit(1);
    },
    open(socket) {
      socket.write(`${cmd}\n`);
      socket.end();
    },
    close() {
      process.exit(0);
    },
  },
});
