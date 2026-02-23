#!/usr/bin/env bash
# STT Setup Script
# Installs system deps, builds whisper.cpp with CUDA, downloads model, configures sxhkd
set -euo pipefail

STT_DIR="$HOME/.local/share/stt"
WHISPER_DIR="$STT_DIR/whisper.cpp"
MODELS_DIR="$STT_DIR/models"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# ─── Helpers ──────────────────────────────────────────────────────────────────

info()    { echo -e "\033[1;34m[setup]\033[0m $*"; }
success() { echo -e "\033[1;32m[setup]\033[0m $*"; }
warn()    { echo -e "\033[1;33m[setup]\033[0m $*"; }
error()   { echo -e "\033[1;31m[setup]\033[0m $*" >&2; exit 1; }

# ─── System dependencies ──────────────────────────────────────────────────────

info "Installing system dependencies..."

PKGS=(
  git cmake build-essential
  xdotool xclip
  alsa-utils          # arecord fallback
  pulseaudio-utils    # parecord (works with PipeWire too)
  sxhkd
  nvidia-cuda-toolkit # required for GPU-accelerated whisper.cpp
)

# Detect package manager
if command -v apt &>/dev/null; then
  sudo apt-get install -y "${PKGS[@]}"
elif command -v pacman &>/dev/null; then
  # Arch Linux package names differ slightly
  PKGS=(
    git cmake base-devel
    xdotool xclip
    alsa-utils
    libpulse
    sxhkd
    cuda               # AUR: cuda
  )
  sudo pacman -S --needed --noconfirm "${PKGS[@]}"
else
  warn "Could not detect package manager. Please install manually: ${PKGS[*]}"
fi

# ─── Whisper.cpp ──────────────────────────────────────────────────────────────

mkdir -p "$STT_DIR" "$MODELS_DIR"

if [[ ! -d "$WHISPER_DIR" ]]; then
  info "Cloning whisper.cpp..."
  git clone --depth=1 https://github.com/ggerganov/whisper.cpp.git "$WHISPER_DIR"
else
  info "Updating whisper.cpp..."
  git -C "$WHISPER_DIR" pull --ff-only
fi

cd "$WHISPER_DIR"

if command -v nvcc &>/dev/null; then
  info "Building whisper.cpp with CUDA GPU support..."
  cmake -B build -DGGML_CUDA=ON -DCMAKE_BUILD_TYPE=Release
  cmake --build build --config Release -j"$(nproc)"
  success "Built with CUDA GPU acceleration"
else
  error "nvcc not found. Install the CUDA toolkit first:
  sudo apt-get install nvidia-cuda-toolkit
Then re-run this script."
fi

WHISPER_BIN="$WHISPER_DIR/build/bin/whisper-cli"
[[ -f "$WHISPER_BIN" ]] || error "Build failed — binary not found at $WHISPER_BIN"
success "whisper.cpp built: $WHISPER_BIN"

# ─── Download Whisper model ───────────────────────────────────────────────────

MODEL_NAME="${WHISPER_MODEL_NAME:-large-v3}"
MODEL_FILE="$MODELS_DIR/ggml-${MODEL_NAME}.bin"

info "Available models (by accuracy/speed trade-off):"
echo "  tiny    (~75MB)   — fastest, less accurate"
echo "  base    (~145MB)  — fast, decent accuracy"
echo "  small   (~466MB)  — good balance"
echo "  medium  (~1.5GB)  — great accuracy"
echo "  large-v3 (~3GB)   — best accuracy (recommended for RTX 3080)"

if [[ ! -f "$MODEL_FILE" ]]; then
  info "Downloading Whisper model: $MODEL_NAME"
  bash "$WHISPER_DIR/models/download-ggml-model.sh" "$MODEL_NAME" "$MODELS_DIR" \
    || {
      # Fallback: direct download
      MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${MODEL_NAME}.bin"
      info "Trying direct download from HuggingFace..."
      wget -c -O "$MODEL_FILE" "$MODEL_URL"
    }
  success "Model downloaded: $MODEL_FILE"
else
  info "Model already exists: $MODEL_FILE"
fi

# ─── Ollama model ─────────────────────────────────────────────────────────────

info "Checking Ollama..."
if command -v ollama &>/dev/null; then
  OLLAMA_MODEL="${OLLAMA_MODEL:-llama3.2:3b}"
  info "Pulling Ollama model: $OLLAMA_MODEL"
  ollama pull "$OLLAMA_MODEL"
  success "Ollama model ready: $OLLAMA_MODEL"
else
  warn "Ollama not found. Install it from: https://ollama.com/download"
  warn "Then run: ollama pull llama3.2:3b"
fi

# ─── .env file ────────────────────────────────────────────────────────────────

ENV_FILE="$PROJECT_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  info "Creating .env from template..."
  sed \
    -e "s|WHISPER_BIN=.*|WHISPER_BIN=$WHISPER_BIN|" \
    -e "s|WHISPER_MODEL=.*|WHISPER_MODEL=$MODEL_FILE|" \
    "$PROJECT_DIR/.env.example" > "$ENV_FILE"
  success "Created $ENV_FILE"
else
  info ".env already exists — skipping (edit manually if needed)"
fi

# ─── sxhkd config ─────────────────────────────────────────────────────────────

SXHKD_CONFIG="$HOME/.config/sxhkd/sxhkdrc"
mkdir -p "$(dirname "$SXHKD_CONFIG")"

STT_BLOCK="# ── STT toggle (managed by speech_transcriber) ──
$(cat "$PROJECT_DIR/config/sxhkdrc")"

if [[ ! -f "$SXHKD_CONFIG" ]]; then
  info "Creating sxhkd config..."
  echo "$STT_BLOCK" > "$SXHKD_CONFIG"
  success "Created $SXHKD_CONFIG"
elif grep -q "speech_transcriber\|stt-daemon" "$SXHKD_CONFIG"; then
  info "sxhkd config already contains STT binding — skipping"
else
  info "Appending STT hotkey to existing $SXHKD_CONFIG..."
  echo -e "\n$STT_BLOCK" >> "$SXHKD_CONFIG"
  success "Appended to $SXHKD_CONFIG"
fi

# Reload sxhkd if running
if pgrep -x sxhkd &>/dev/null; then
  pkill -USR1 sxhkd
  info "Reloaded sxhkd config"
fi

# ─── systemd user service ─────────────────────────────────────────────────────

SERVICE_DIR="$HOME/.config/systemd/user"
mkdir -p "$SERVICE_DIR"

BUN_BIN="$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")"

cat > "$SERVICE_DIR/stt-daemon.service" << EOF
[Unit]
Description=Speech-to-Text Daemon
After=graphical-session.target
PartOf=graphical-session.target

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
ExecStart=$BUN_BIN $PROJECT_DIR/src/daemon.ts
Restart=on-failure
RestartSec=3
Environment=DISPLAY=$DISPLAY_NUM
Environment=XAUTHORITY=$XAUTH_PATH

[Install]
WantedBy=graphical-session.target
EOF

# Detect current display for the service (auto-detect in script as fallback)
DISPLAY_NUM="${DISPLAY:-:1}"
XAUTH_PATH="${XAUTHORITY:-/run/user/$(id -u)/gdm/Xauthority}"
[[ -f "$XAUTH_PATH" ]] || XAUTH_PATH="$HOME/.Xauthority"

cat > "$SERVICE_DIR/stt-status.service" << EOF
[Unit]
Description=dwm Status Bar (STT mic indicator + clock)
After=graphical-session.target
PartOf=graphical-session.target

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
ExecStart=$PROJECT_DIR/scripts/dwm-status.sh
Restart=on-failure
RestartSec=3
Environment=DISPLAY=$DISPLAY_NUM
Environment=XAUTHORITY=$XAUTH_PATH

[Install]
WantedBy=graphical-session.target
EOF

systemctl --user daemon-reload
systemctl --user enable stt-daemon.service stt-status.service

success "systemd services installed: stt-daemon.service, stt-status.service"
info "  Start:   systemctl --user start stt-daemon stt-status"
info "  Stop:    systemctl --user stop stt-daemon stt-status"
info "  Logs:    journalctl --user -fu stt-daemon"
info "  Logs:    journalctl --user -fu stt-status"

# ─── Summary ──────────────────────────────────────────────────────────────────

echo ""
success "Setup complete!"
echo ""
echo "  Hotkey:     Super + grave (backtick)  [edit config/sxhkdrc to change]"
echo "  Start now:  systemctl --user start stt-daemon stt-status"
echo "  Or:         bun run daemon  (+ bash scripts/dwm-status.sh in another terminal)"
echo ""
echo "  dwm bar:    🎤 gray=idle  🔴🎤 red=recording  🟡🎤 yellow=transcribing"
echo "  Colors:     set DWM_STATUS_COLORS=true in .env if dwm has status2d patch"
