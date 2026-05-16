#!/usr/bin/env bash
# DLT Log Viewer Mock GPS Relay 자동 설치 스크립트 (macOS / Linux)
# 사용법:
#   curl -fsSL https://honor436.github.io/DltLogViewer/scripts/install.sh | bash
set -euo pipefail

BASE_URL="${MOCKGPS_BASE_URL:-https://honor436.github.io/DltLogViewer}"
DEST="$HOME/.mockgps"
PYTHON=""
LABEL="com.mns.mockgps-relay"

c_red()    { printf '\033[31m%s\033[0m' "$1"; }
c_green()  { printf '\033[32m%s\033[0m' "$1"; }
c_yellow() { printf '\033[33m%s\033[0m' "$1"; }
c_blue()   { printf '\033[34m%s\033[0m' "$1"; }

step()  { echo ""; echo "$(c_blue '▸') $*"; }
ok()    { echo "  $(c_green '✓') $*"; }
warn()  { echo "  $(c_yellow '⚠') $*"; }
fail()  { echo "  $(c_red   '✗') $*"; exit 1; }

# ---------------- 0. OS 감지 ----------------
case "$(uname -s)" in
  Darwin*) OS=macos ;;
  Linux*)  OS=linux ;;
  *)       fail "지원되지 않는 OS: $(uname -s) (macOS / Linux 만 지원)" ;;
esac
step "OS: $(c_green "$OS")"

# ---------------- 1. python3 확인 ----------------
step "Python3 확인"
if command -v python3 >/dev/null 2>&1; then
  PYTHON="$(command -v python3)"
  ok "found: $PYTHON ($($PYTHON --version 2>&1))"
else
  if [[ "$OS" == "macos" ]]; then
    if command -v brew >/dev/null 2>&1; then
      warn "Python3 미설치 → Homebrew 로 설치 시도"
      brew install python3 || fail "brew install python3 실패"
      PYTHON="$(command -v python3)"
    else
      fail "Python3 가 필요합니다. https://www.python.org/downloads/ 에서 설치 후 다시 시도하세요."
    fi
  else
    fail "Python3 가 필요합니다. (apt: sudo apt install python3)"
  fi
fi

# ---------------- 2. adb 확인 ----------------
step "ADB 확인"
if command -v adb >/dev/null 2>&1; then
  ok "found: $(command -v adb)"
elif [[ -x "$HOME/Library/Android/sdk/platform-tools/adb" ]]; then
  ok "found: $HOME/Library/Android/sdk/platform-tools/adb"
elif [[ -x "$HOME/Android/Sdk/platform-tools/adb" ]]; then
  ok "found: $HOME/Android/Sdk/platform-tools/adb"
else
  warn "ADB 가 PATH 에 없습니다."
  warn "Android Studio 설치 후 platform-tools 경로를 PATH 에 추가하거나,"
  warn "  macOS: brew install --cask android-platform-tools"
  warn "  Linux: sudo apt install android-tools-adb"
  warn "(릴레이는 설치하되, adb 가 없으면 동작하지 않습니다)"
fi

# ---------------- 3. 디렉토리 생성 ----------------
step "$DEST 생성"
mkdir -p "$DEST"
ok "$DEST"

# ---------------- 4. 파일 다운로드 ----------------
step "릴레이 + APK 다운로드 ($BASE_URL)"
curl -fsSL "$BASE_URL/adb-relay.py"          -o "$DEST/adb-relay.py"          && ok "adb-relay.py"
curl -fsSL "$BASE_URL/assets/MnsMockGps.apk" -o "$DEST/MnsMockGps.apk"        && ok "MnsMockGps.apk ($(du -h "$DEST/MnsMockGps.apk" | cut -f1))"

chmod +x "$DEST/adb-relay.py"

# ---------------- 5. 기존 실행 프로세스 중지 ----------------
step "기존 릴레이 종료"
if pgrep -f "adb-relay.py" >/dev/null 2>&1; then
  pkill -f "adb-relay.py" || true
  sleep 0.5
  ok "기존 프로세스 종료"
else
  ok "실행 중 인스턴스 없음"
fi

# ---------------- 6. 자동 시작 등록 ----------------
if [[ "$OS" == "macos" ]]; then
  step "launchd 자동 시작 등록"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<EOF
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
EOF
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load   "$PLIST"
  ok "$PLIST"
  ok "PC 부팅 시 자동 시작됩니다."
elif [[ "$OS" == "linux" ]]; then
  step "systemd --user 등록"
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/mockgps-relay.service" <<EOF
[Unit]
Description=DLT Log Viewer Mock GPS Relay
After=network.target

[Service]
ExecStart=$PYTHON $DEST/adb-relay.py
Restart=always
WorkingDirectory=$DEST

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload || true
  systemctl --user enable --now mockgps-relay.service || warn "systemd --user 활성화 실패. 직접 실행해주세요: $PYTHON $DEST/adb-relay.py"
  ok "systemctl --user enable --now mockgps-relay.service"
fi

# ---------------- 7. 동작 확인 ----------------
step "릴레이 헬스체크 (포트 21234)"
sleep 1.5
if curl -fsS http://localhost:21234/ping >/dev/null 2>&1; then
  ok "$(curl -fsS http://localhost:21234/ping)"
else
  warn "헬스체크 실패. 수동 실행: $PYTHON $DEST/adb-relay.py"
fi

# ---------------- 완료 ----------------
echo ""
c_green "════════════════════════════════════════════════════"; echo ""
c_green "  ✅ Mock GPS 릴레이 설치 완료"; echo ""
c_green "════════════════════════════════════════════════════"; echo ""
echo ""
echo "   설치 위치  : $DEST"
echo "   릴레이 URL : http://localhost:21234"
echo ""
echo "   이제 웹페이지로 돌아가 새로고침하세요:"
echo "   👉 https://honor436.github.io/DltLogViewer/"
echo ""
echo "   제거하려면:"
if [[ "$OS" == "macos" ]]; then
  echo "     launchctl unload ~/Library/LaunchAgents/$LABEL.plist"
  echo "     rm -rf $DEST ~/Library/LaunchAgents/$LABEL.plist"
else
  echo "     systemctl --user disable --now mockgps-relay.service"
  echo "     rm -rf $DEST ~/.config/systemd/user/mockgps-relay.service"
fi
echo ""
