#!/usr/bin/env python3
"""
ADB Mock GPS Relay Server
-------------------------
브라우저의 DLT Log Viewer에서 요청한 좌표를 받아
  adb emu geo fix <lon> <lat>
명령으로 에뮬레이터에 Mock GPS를 전송합니다.

실행 방법:
  python3 DltLogViewer/adb-relay.py

기본 포트: 21234  (변경: python3 adb-relay.py --port 12345)
"""

import http.server
import subprocess
import json
import argparse
import shutil
from urllib.parse import urlparse, parse_qs

PORT = 21234
CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Content-Type': 'application/json; charset=utf-8',
}


def find_adb():
    """adb 실행파일 경로를 찾는다. PATH에 없으면 Android SDK 기본 경로를 확인."""
    adb = shutil.which('adb')
    if adb:
        return adb
    import os, pathlib
    candidates = [
        pathlib.Path.home() / 'Library/Android/sdk/platform-tools/adb',  # macOS
        pathlib.Path.home() / 'Android/Sdk/platform-tools/adb',           # Linux
        pathlib.Path('C:/Users') / os.getenv('USERNAME', '') / 'AppData/Local/Android/Sdk/platform-tools/adb.exe',  # Windows
    ]
    for c in candidates:
        if c.exists():
            return str(c)
    return None


ADB = find_adb()


class RelayHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f'  {self.address_string()} {fmt % args}')

    def send_json(self, code: int, body: dict):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        for k, v in CORS_HEADERS.items():
            self.send_header(k, v)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_json(204, {})

    def do_GET(self):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)

        # ---- Health check ----
        if parsed.path in ('/', '/ping'):
            self.send_json(200, {
                'status': 'ok',
                'adb': ADB or 'not found',
                'adb_found': bool(ADB),
            })
            return

        # ---- Device list ----
        if parsed.path == '/devices':
            if not ADB:
                self.send_json(500, {'ok': False, 'error': 'adb를 찾을 수 없습니다.'})
                return
            try:
                result = subprocess.run([ADB, 'devices'], capture_output=True, text=True, timeout=5)
                devices = []
                for line in result.stdout.splitlines()[1:]:  # 첫 줄("List of devices attached") 제외
                    parts = line.strip().split('\t')
                    if len(parts) == 2 and parts[1] == 'device':
                        devices.append(parts[0])
                self.send_json(200, {'ok': True, 'devices': devices, 'count': len(devices)})
            except subprocess.TimeoutExpired:
                self.send_json(504, {'ok': False, 'error': 'adb 타임아웃'})
            except Exception as e:
                self.send_json(500, {'ok': False, 'error': str(e)})
            return

        # ---- Mock GPS ----
        if parsed.path == '/mock-gps':
            try:
                lat = float(qs['lat'][0])
                lon = float(qs['lon'][0])
            except (KeyError, ValueError, IndexError):
                self.send_json(400, {'ok': False, 'error': 'lat, lon 파라미터 필요'})
                return

            # 선택 파라미터
            alt        = float(qs['alt'][0])        if 'alt'        in qs else 0.0
            satellites = int(qs['satellites'][0])   if 'satellites' in qs else None

            if not ADB:
                self.send_json(500, {'ok': False, 'error': 'adb를 찾을 수 없습니다. PATH 또는 ANDROID_HOME을 확인하세요.'})
                return

            # adb emu geo fix <longitude> <latitude> [altitude [satellites]]
            cmd = [ADB, 'emu', 'geo', 'fix', str(lon), str(lat), str(alt)]
            if satellites is not None:
                cmd.append(str(satellites))
            try:
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
                ok = result.returncode == 0
                self.send_json(200 if ok else 500, {
                    'ok': ok,
                    'cmd': ' '.join(cmd),
                    'stdout': result.stdout.strip(),
                    'stderr': result.stderr.strip(),
                    'lat': lat, 'lon': lon, 'alt': alt,
                    **(({'satellites': satellites}) if satellites is not None else {}),
                })
            except subprocess.TimeoutExpired:
                self.send_json(504, {'ok': False, 'error': 'adb 타임아웃 (에뮬레이터 연결 확인)'})
            except Exception as e:
                self.send_json(500, {'ok': False, 'error': str(e)})
            return

        self.send_json(404, {'error': 'Not found'})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='ADB Mock GPS Relay Server')
    parser.add_argument('--port', type=int, default=PORT, help=f'리스닝 포트 (기본값: {PORT})')
    args = parser.parse_args()

    if not ADB:
        print('⚠️  경고: adb를 찾지 못했습니다. PATH에 adb를 추가하거나 Android SDK를 설치하세요.')
    else:
        print(f'✅ adb 경로: {ADB}')

    print(f'🚀 ADB Mock GPS Relay 서버 시작')
    print(f'   http://localhost:{args.port}/mock-gps?lat=37.4979&lon=127.0276')
    print('   Ctrl+C 로 종료\n')

    server = http.server.HTTPServer(('127.0.0.1', args.port), RelayHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n서버 종료.')
