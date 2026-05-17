# DLT Log Viewer Mock GPS Relay auto-installer (Windows PowerShell)
# Usage:
#   iwr https://honor436.github.io/DltLogViewer/scripts/install.ps1 -UseBasicParsing | iex

$ErrorActionPreference = "Stop"

$BaseUrl  = if ($env:MOCKGPS_BASE_URL) { $env:MOCKGPS_BASE_URL } else { "https://honor436.github.io/DltLogViewer" }
$Dest     = Join-Path $env:USERPROFILE ".mockgps"
$TaskName = "MnsMockGpsRelay"

function Step($m) { Write-Host ""; Write-Host "[ $m ]" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  OK   $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  WARN $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "  ERR  $m" -ForegroundColor Red; exit 1 }

# ---- 1. Python ----
Step "Python"
$python = $null
foreach ($cmd in @("python", "python3", "py")) {
    if (Get-Command $cmd -ErrorAction SilentlyContinue) {
        $python = (Get-Command $cmd).Source
        $ver = & $cmd --version 2>&1
        Ok "found: $python ($ver)"
        break
    }
}
if (-not $python) {
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Warn "python not found, installing via winget"
        winget install -e --id Python.Python.3.12 --silent
        $python = (Get-Command python).Source
    } else {
        Fail "Python required. https://www.python.org/downloads/"
    }
}

# ---- 2. ADB ----
Step "ADB"
if (Get-Command adb -ErrorAction SilentlyContinue) {
    Ok "found: $((Get-Command adb).Source)"
} else {
    $candidate = Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"
    if (Test-Path $candidate) {
        Ok "found: $candidate"
    } else {
        Warn "adb not in PATH"
        Warn "Install Android Platform Tools:"
        Warn "  https://developer.android.com/tools/releases/platform-tools"
        Warn "(relay installed but will not work until adb is available)"
    }
}

# ---- 3. dest dir ----
Step "Create $Dest"
New-Item -ItemType Directory -Path $Dest -Force | Out-Null
Ok $Dest

# ---- 4. download ----
Step "Download relay + APK from $BaseUrl"
Invoke-WebRequest -Uri "$BaseUrl/adb-relay.py"          -OutFile (Join-Path $Dest "adb-relay.py")   -UseBasicParsing
Ok "adb-relay.py"
Invoke-WebRequest -Uri "$BaseUrl/assets/MnsMockGps.apk" -OutFile (Join-Path $Dest "MnsMockGps.apk") -UseBasicParsing
$apkSize = (Get-Item (Join-Path $Dest "MnsMockGps.apk")).Length
Ok ("MnsMockGps.apk ({0:N1} MB)" -f ($apkSize / 1MB))

# ---- 5. stop existing ----
Step "Stop existing relay"
$running = Get-Process | Where-Object { $_.CommandLine -like "*adb-relay.py*" } -ErrorAction SilentlyContinue
if ($running) {
    $running | Stop-Process -Force
    Start-Sleep -Milliseconds 500
    Ok "stopped previous instance"
} else {
    Ok "no running instance"
}

# ---- 6. scheduled task ----
Step "Register scheduled task (run at logon)"
$relayPath = Join-Path $Dest "adb-relay.py"
$action  = New-ScheduledTaskAction  -Execute $python -Argument "`"$relayPath`"" -WorkingDirectory $Dest
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "DLT Log Viewer Mock GPS Relay" | Out-Null
Ok "Task: $TaskName"

Start-ScheduledTask -TaskName $TaskName
Ok "started"

# ---- 7. health check ----
Step "Health check (port 21234)"
Start-Sleep -Seconds 2
try {
    $resp = Invoke-WebRequest -Uri "http://localhost:21234/ping" -UseBasicParsing -TimeoutSec 4
    Ok $resp.Content
} catch {
    Warn "health check failed. run manually: $python `"$relayPath`""
}

# ---- done ----
Write-Host ""
Write-Host "====================================================" -ForegroundColor Green
Write-Host "  Mock GPS Relay installation complete" -ForegroundColor Green
Write-Host "====================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Installed at : $Dest"
Write-Host "  Relay URL    : http://localhost:21234"
Write-Host ""
Write-Host "  Reload the web page now:"
Write-Host "  https://honor436.github.io/DltLogViewer/" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Uninstall:"
Write-Host "    Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
Write-Host "    Remove-Item -Recurse -Force $Dest"
Write-Host ""
