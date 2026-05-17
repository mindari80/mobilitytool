#!/usr/bin/env bash
# DLT Log Viewer Mock GPS Relay auto-installer (macOS / Linux)
# Usage:
#   curl -fsSL https://honor436.github.io/DltLogViewer/scripts/install.sh | bash
set -euo pipefail

BASE_URL="${MOCKGPS_BASE_URL:-https://honor436.github.io/DltLogViewer}"
DEST="$HOME/.mockgps"
LABEL="com.mns.mockgps-relay"
PYTHON=""

step() { printf "\n[ %s ]\n" "$1"; }
ok()   { printf "  OK   %s\n"  "$1"; }
warn() { printf "  WARN %s\n"  "$1"; }
fail() { printf "  ERR  %s\n"  "$1"; exit 1; }

# ---------------- 0. OS ----------------
case "$(uname -s)" in
  Darwin*) OS=macos ;;
  Linux*)  OS=linux ;;
  *)       fail "Unsupported OS: $(uname -s) (macOS / Linux only)" ;;
esac
step "OS: $OS"

# ---------------- 1. python3 ----------------
step "Python3"
if command -v python3 >/dev/null 2>&1; then
  PYTHON="$(command -v python3)"
  ok "found: $PYTHON ($($PYTHON --version 2>&1))"
else
  if [ "$OS" = "macos" ] && command -v brew >/dev/null 2>&1; then
    warn "python3 not found, installing via Homebrew"
    brew install python3 || fail "brew install python3 failed"
    PYTHON="$(command -v python3)"
  else
    fail "Python3 required. Install: https://www.python.org/downloads/"
  fi
fi

# ---------------- 2. adb ----------------
step "ADB"
if command -v adb >/dev/null 2>&1; then
  ok "found: $(command -v adb)"
elif [ -x "$HOME/Library/Android/sdk/platform-tools/adb" ]; then
  ok "found: $HOME/Library/Android/sdk/platform-tools/adb"
elif [ -x "$HOME/Android/Sdk/platform-tools/adb" ]; then
  ok "found: $HOME/Android/Sdk/platform-tools/adb"
else
  warn "adb not in PATH"
  warn "  macOS: brew install --cask android-platform-tools"
  warn "  Linux: sudo apt install android-tools-adb"
  warn "(relay installed but will not work until adb is available)"
fi

# ---------------- 3. dest dir ----------------
step "Create $DEST"
mkdir -p "$DEST"
ok "$DEST"

# ---------------- 4. download ----------------
step "Download relay + APK from $BASE_URL"
curl -fsSL "$BASE_URL/adb-relay.py"          -o "$DEST/adb-relay.py"   && ok "adb-relay.py"
curl -fsSL "$BASE_URL/assets/MnsMockGps.apk" -o "$DEST/MnsMockGps.apk" && ok "MnsMockGps.apk ($(du -h "$DEST/MnsMockGps.apk" | cut -f1))"
chmod +x "$DEST/adb-relay.py"

# ---------------- 5. stop existing ----------------
step "Stop existing relay"
if pgrep -f "adb-relay.py" >/dev/null 2>&1; then
  pkill -f "adb-relay.py" || true
  sleep 0.5
  ok "stopped previous instance"
else
  ok "no running instance"
fi

# ---------------- 6. auto-start ----------------
if [ "$OS" = "macos" ]; then
  step "Register launchd"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PYTHON</string>
    <string>$DEST/adb-relay.py</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DEST/relay.log</string>
  <key>StandardErrorPath</key><string>$DEST/relay.err</string>
  <key>WorkingDirectory</key><string>$DEST</string>
</dict>
</plist>
PLIST_EOF
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load   "$PLIST"
  ok "$PLIST"
  ok "auto-starts at login"
elif [ "$OS" = "linux" ]; then
  step "Register systemd --user"
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/mockgps-relay.service" <<UNIT_EOF
[Unit]
Description=DLT Log Viewer Mock GPS Relay
After=network.target

[Service]
ExecStart=$PYTHON $DEST/adb-relay.py
Restart=always
WorkingDirectory=$DEST

[Install]
WantedBy=default.target
UNIT_EOF
  systemctl --user daemon-reload || true
  systemctl --user enable --now mockgps-relay.service || warn "systemd --user activation failed. run manually: $PYTHON $DEST/adb-relay.py"
  ok "systemctl --user enable --now mockgps-relay.service"
fi

# ---------------- 7. health check ----------------
step "Health check (port 21234)"
sleep 1.5
if curl -fsS http://localhost:21234/ping >/dev/null 2>&1; then
  ok "$(curl -fsS http://localhost:21234/ping)"
else
  warn "health check failed. run manually: $PYTHON $DEST/adb-relay.py"
fi

# ---------------- done ----------------
printf "\n====================================================\n"
printf "  Mock GPS Relay installation complete\n"
printf "====================================================\n\n"
printf "  Installed at : %s\n" "$DEST"
printf "  Relay URL    : http://localhost:21234\n\n"
printf "  Reload the web page now:\n"
printf "  https://honor436.github.io/DltLogViewer/\n\n"
printf "  Uninstall:\n"
if [ "$OS" = "macos" ]; then
  printf "    launchctl unload ~/Library/LaunchAgents/%s.plist\n" "$LABEL"
  printf "    rm -rf %s ~/Library/LaunchAgents/%s.plist\n" "$DEST" "$LABEL"
else
  printf "    systemctl --user disable --now mockgps-relay.service\n"
  printf "    rm -rf %s ~/.config/systemd/user/mockgps-relay.service\n" "$DEST"
fi
printf "\n"
