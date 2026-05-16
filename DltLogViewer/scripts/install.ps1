# DLT Log Viewer Mock GPS Relay 자동 설치 스크립트 (Windows PowerShell)
# 사용법:
#   iwr https://honor436.github.io/DltLogViewer/scripts/install.ps1 -UseBasicParsing | iex

$ErrorActionPreference = 'Stop'

$BaseUrl = if ($env:MOCKGPS_BASE_URL) { $env:MOCKGPS_BASE_URL } else { 'https://honor436.github.io/DltLogViewer' }
$Dest    = Join-Path $env:USERPROFILE '.mockgps'
$TaskName = 'MnsMockGpsRelay'

function Step($msg)  { Write-Host ""; Write-Host "▸ $msg" -ForegroundColor Cyan }
function Ok($msg)    { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Warn($msg)  { Write-Host "  ⚠ $msg" -ForegroundColor Yellow }
function Fail($msg)  { Write-Host "  ✗ $msg" -ForegroundColor Red; exit 1 }

# ---------------- 1. Python 확인 ----------------
Step 'Python 확인'
$python = $null
foreach ($cmd in @('python', 'python3', 'py')) {
    if (Get-Command $cmd -ErrorAction SilentlyContinue) {
        $python = (Get-Command $cmd).Source
        $ver = & $cmd --version 2>&1
        Ok "found: $python ($ver)"
        break
    }
}
if (-not $python) {
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Warn 'Python 미설치 → winget 으로 설치 시도'
        winget install -e --id Python.Python.3.12 --silent
        $python = (Get-Command python).Source
    } else {
        Fail 'Python 이 필요합니다. https://www.python.org/downloads/ 에서 설치 후 다시 시도하세요.'
    }
}

# ---------------- 2. ADB 확인 ----------------
Step 'ADB 확인'
$adb = $null
if (Get-Command adb -ErrorAction SilentlyContinue) {
    $adb = (Get-Command adb).Source
    Ok "found: $adb"
} else {
    $candidate = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'
    if (Test-Path $candidate) {
        Ok "found: $candidate"
    } else {
        Warn 'ADB 가 PATH 에 없습니다.'
        Warn 'Android Studio 또는 Platform Tools 를 설치하세요:'
        Warn '  https://developer.android.com/tools/releases/platform-tools'
        Warn '(릴레이는 설치하되, adb 가 없으면 동작하지 않습니다)'
    }
}

# ---------------- 3. 디렉토리 생성 ----------------
Step "$Dest 생성"
New-Item -ItemType Directory -Path $Dest -Force | Out-Null
Ok $Dest

# ---------------- 4. 파일 다운로드 ----------------
Step "릴레이 + APK 다운로드 ($BaseUrl)"
Invoke-WebRequest -Uri "$BaseUrl/adb-relay.py"          -OutFile (Join-Path $Dest 'adb-relay.py')   -UseBasicParsing
Ok 'adb-relay.py'
Invoke-WebRequest -Uri "$BaseUrl/assets/MnsMockGps.apk" -OutFile (Join-Path $Dest 'MnsMockGps.apk') -UseBasicParsing
$apkSize = (Get-Item (Join-Path $Dest 'MnsMockGps.apk')).Length
Ok ("MnsMockGps.apk ({0:N1} MB)" -f ($apkSize / 1MB))

# ---------------- 5. 기존 프로세스 중지 ----------------
Step '기존 릴레이 종료'
$running = Get-Process | Where-Object { $_.CommandLine -like '*adb-relay.py*' } -ErrorAction SilentlyContinue
if ($running) {
    $running | Stop-Process -Force
    Start-Sleep -Milliseconds 500
    Ok '기존 프로세스 종료'
} else {
    Ok '실행 중 인스턴스 없음'
}

# ---------------- 6. 작업 스케줄러 자동 시작 등록 ----------------
Step '작업 스케줄러 등록 (로그인 시 자동 시작)'
$action  = New-ScheduledTaskAction  -Execute $python -Argument "`"$(Join-Path $Dest 'adb-relay.py')`"" -WorkingDirectory $Dest
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

# 기존 작업 삭제
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'DLT Log Viewer Mock GPS Relay' | Out-Null
Ok "Task: $TaskName"

# 지금 한 번 실행
Start-ScheduledTask -TaskName $TaskName
Ok '지금 실행됨'

# ---------------- 7. 동작 확인 ----------------
Step '릴레이 헬스체크 (포트 21234)'
Start-Sleep -Seconds 2
try {
    $resp = Invoke-WebRequest -Uri 'http://localhost:21234/ping' -UseBasicParsing -TimeoutSec 4
    Ok $resp.Content
} catch {
    Warn "헬스체크 실패. 수동 실행: $python `"$(Join-Path $Dest 'adb-relay.py')`""
}

# ---------------- 완료 ----------------
Write-Host ''
Write-Host '════════════════════════════════════════════════════' -ForegroundColor Green
Write-Host '  ✅ Mock GPS 릴레이 설치 완료' -ForegroundColor Green
Write-Host '════════════════════════════════════════════════════' -ForegroundColor Green
Write-Host ''
Write-Host "   설치 위치  : $Dest"
Write-Host "   릴레이 URL : http://localhost:21234"
Write-Host ''
Write-Host '   이제 웹페이지로 돌아가 새로고침하세요:'
Write-Host '   👉 https://honor436.github.io/DltLogViewer/' -ForegroundColor Cyan
Write-Host ''
Write-Host '   제거하려면:'
Write-Host "     Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
Write-Host "     Remove-Item -Recurse -Force $Dest"
Write-Host ''
