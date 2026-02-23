#!/usr/bin/env bash
# dwm status bar — microphone state indicator + clock
#
# Mic icon states:
#   gray   🎤  = idle
#   red    🎤  = recording (live)
#   yellow 🎤  = transcribing / processing
#
# Color support requires dwm with the status2d patch.
# Set DWM_STATUS_COLORS=true in .env to enable it.
# Without the patch, leave it false — plain emoji indicators are used instead.
#
# Run standalone:  bash scripts/dwm-status.sh
# As a service:    systemctl --user start stt-status

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
STATUS_FILE="/tmp/stt-status"

# Load .env if present
if [[ -f "$PROJECT_DIR/.env" ]]; then
  # shellcheck disable=SC1091
  set -a; source "$PROJECT_DIR/.env"; set +a
fi

# Auto-detect DISPLAY if not set (systemd services don't inherit it)
if [[ -z "$DISPLAY" ]]; then
  for _d in 0 1 2 3; do
    [[ -f "/tmp/.X${_d}-lock" ]] && { export DISPLAY=":${_d}"; break; }
  done
fi

# Auto-detect XAUTHORITY if not set
if [[ -z "$XAUTHORITY" ]]; then
  _uid=$(id -u)
  for _xa in \
    "/run/user/${_uid}/gdm/Xauthority" \
    "$HOME/.Xauthority" \
    "/tmp/.xauth-${_uid}"
  do
    [[ -f "$_xa" ]] && { export XAUTHORITY="$_xa"; break; }
  done
fi

USE_COLORS="${DWM_STATUS_COLORS:-false}"

# Nerd Fonts microphone glyph (󰍬). Falls back gracefully if font lacks glyph.
MIC_ICON="󰍬"

mic_widget() {
  local raw
  raw=$(cat "$STATUS_FILE" 2>/dev/null || echo "")

  if [[ "$USE_COLORS" == "true" ]]; then
    # status2d patch syntax: ^c#RRGGBB^ text ^d^
    case "$raw" in
      "[idle]"|"") echo "^c#888888^${MIC_ICON}^d^" ;;          # gray — idle
      "[REC]")      echo "^c#FF3333^${MIC_ICON}^d^" ;;          # red  — recording
      *)            echo "^c#FFCC00^${MIC_ICON}^d^" ;;          # yellow — processing
    esac
  else
    # Plain text with emoji color indicators
    case "$raw" in
      "[idle]"|"") echo "🎤" ;;
      "[REC]")      echo "🔴🎤" ;;
      *)            echo "🟡🎤" ;;
    esac
  fi
}

update_bar() {
  local mic clock
  mic=$(mic_widget)
  clock=$(date '+%a %d %b %H:%M')
  xsetroot -name " ${mic}  ${clock}"
}

# Run once immediately, then loop every second
update_bar
while true; do
  sleep 1
  update_bar
done
