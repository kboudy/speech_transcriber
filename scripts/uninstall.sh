#!/usr/bin/env bash
# STT Uninstall Script
# Reverses everything done by setup.sh
set -euo pipefail

STT_DIR="$HOME/.local/share/stt"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SERVICE_DIR="$HOME/.config/systemd/user"
SXHKD_CONFIG="$HOME/.config/sxhkd/sxhkdrc"

info()    { echo -e "\033[1;34m[uninstall]\033[0m $*"; }
success() { echo -e "\033[1;32m[uninstall]\033[0m $*"; }
warn()    { echo -e "\033[1;33m[uninstall]\033[0m $*"; }

# ─── systemd services ─────────────────────────────────────────────────────────

for svc in stt-daemon stt-status; do
  if systemctl --user is-active --quiet "$svc" 2>/dev/null; then
    info "Stopping $svc..."
    systemctl --user stop "$svc"
  fi
  if systemctl --user is-enabled --quiet "$svc" 2>/dev/null; then
    info "Disabling $svc..."
    systemctl --user disable "$svc"
  fi
  svc_file="$SERVICE_DIR/${svc}.service"
  if [[ -f "$svc_file" ]]; then
    rm "$svc_file"
    success "Removed $svc_file"
  fi
done

systemctl --user daemon-reload

# ─── sxhkd config ─────────────────────────────────────────────────────────────

if [[ -f "$SXHKD_CONFIG" ]] && grep -q "speech_transcriber\|stt-daemon" "$SXHKD_CONFIG"; then
  # Remove the STT block: from the marker comment to the blank line after the binding
  sed -i '/# ── STT toggle (managed by speech_transcriber)/,/^$/d' "$SXHKD_CONFIG"
  # If the file is now empty (setup created it fresh), remove it
  if [[ ! -s "$SXHKD_CONFIG" ]]; then
    rm "$SXHKD_CONFIG"
    success "Removed $SXHKD_CONFIG (was created by setup)"
  else
    success "Removed STT block from $SXHKD_CONFIG"
  fi
  # Reload sxhkd if running
  if pgrep -x sxhkd &>/dev/null; then
    pkill -USR1 sxhkd
    info "Reloaded sxhkd config"
  fi
fi

# ─── whisper.cpp and models ───────────────────────────────────────────────────

if [[ -d "$STT_DIR" ]]; then
  read -r -p "Remove $STT_DIR (whisper.cpp build + models ~3GB+)? [y/N] " confirm
  if [[ "${confirm,,}" == "y" ]]; then
    rm -rf "$STT_DIR"
    success "Removed $STT_DIR"
  else
    warn "Skipped $STT_DIR"
  fi
fi

# ─── Ollama model ─────────────────────────────────────────────────────────────

if command -v ollama &>/dev/null; then
  OLLAMA_MODEL="${OLLAMA_MODEL:-llama3.2:3b}"
  if ollama list 2>/dev/null | grep -q "^${OLLAMA_MODEL}"; then
    read -r -p "Remove Ollama model '$OLLAMA_MODEL'? [y/N] " confirm
    if [[ "${confirm,,}" == "y" ]]; then
      ollama rm "$OLLAMA_MODEL"
      success "Removed Ollama model: $OLLAMA_MODEL"
    else
      warn "Skipped Ollama model: $OLLAMA_MODEL"
    fi
  fi
fi

# ─── .env file ────────────────────────────────────────────────────────────────

ENV_FILE="$PROJECT_DIR/.env"
if [[ -f "$ENV_FILE" ]]; then
  read -r -p "Remove $ENV_FILE? [y/N] " confirm
  if [[ "${confirm,,}" == "y" ]]; then
    rm "$ENV_FILE"
    success "Removed $ENV_FILE"
  else
    warn "Skipped $ENV_FILE"
  fi
fi

# ─── Status temp file ─────────────────────────────────────────────────────────

[[ -f /tmp/stt-status ]] && rm /tmp/stt-status && success "Removed /tmp/stt-status"

# ─── Summary ──────────────────────────────────────────────────────────────────

echo ""
success "Uninstall complete."
echo ""
echo "  System packages (xdotool, sxhkd, etc.) were NOT removed."
echo "  Ollama itself was NOT removed."
echo "  The project directory ($PROJECT_DIR) was NOT removed."
echo ""
