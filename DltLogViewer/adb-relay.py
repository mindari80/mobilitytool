#!/usr/bin/env python3
"""
ADB Mock GPS Relay Server  (MnsMockGps 연동판)
---------------------------------------------
브라우저의 DLT Log Viewer에서 받은 좌표를
  adb forward 로 터널링된 TCP 소켓을 통해
  단말의 MnsMockGps 앱(포트 27042)으로 줄단위 JSON으로 전송한다.

  [DLT Log Viewer] --HTTP--> [adb-relay.py] --TCP(adb forward)--> [MnsMockGps 앱]

실행 방법:
  python3 DltLogViewer/adb-relay.py

기본 포트:
  HTTP   21234  (브라우저 ↔ 릴레이)   --port
  앱 TCP 27042  (릴레이 ↔ MnsMockGps) --app-port

엔드포인트:
  GET /            헬스 체크
  GET /devices     연결된 ADB 디바이스 목록
  GET /setup       adb forward + 모의위치 앱 권한(appops) 자동 설정
  GET /mock-gps    좌표 전송  ?lat=&lon=&bearing=&speed_kmh=&alt=&accuracy=
"""

import http.server
import subprocess
import json
import argparse
import shutil
import socket
import threading
from urllib.parse import urlparse, parse_qs

HTTP_PORT = 21234
APP_PORT  = 27042
APP_PACKAGE = 'com.mns.mockgps'

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


# --------------------------------------------------------------------------- #
#  ADB helpers
# --------------------------------------------------------------------------- #
def adb_run(args, timeout=5):
    """adb <args> 실행 → (ok, stdout, stderr)"""
    if not ADB:
        return False, '', 'adb를 찾을 수 없습니다.'
    try:
        r = subprocess.run([ADB] + args, capture_output=True, text=True, timeout=timeout)
        return r.returncode == 0, r.stdout.strip(), r.stderr.strip()
    except subprocess.TimeoutExpired:
        return False, '', 'adb 타임아웃'
    except Exception as e:
        return False, '', str(e)


def list_devices():
    ok, out, err = adb_run(['devices'])
    if not ok:
        return []
    devices = []
    for line in out.splitlines()[1:]:  # 첫 줄("List of devices attached") 제외
        parts = line.strip().split('\t')
        if len(parts) == 2 and parts[1] == 'device':
            devices.append(parts[0])
    return devices


def setup_forward():
    """adb forward tcp:APP_PORT tcp:APP_PORT 설정."""
    return adb_run(['forward', f'tcp:{APP_PORT}', f'tcp:{APP_PORT}'])


def setup_appops():
    """MnsMockGps 를 모의 위치 앱으로 지정 (appops)."""
    return adb_run(['shell', 'appops', 'set', APP_PACKAGE, 'android:mock_location', 'allow'])


# --------------------------------------------------------------------------- #
#  앱 TCP 소켓 (persistent, 자동 재연결)
# --------------------------------------------------------------------------- #
class AppSocket:
    def __init__(self, port):
        self.port = port
        self.sock = None
        self.lock = threading.Lock()

    def _connect(self):
        s = socket.create_connection(('127.0.0.1', self.port), timeout=4)
        s.settimeout(4)
        self.sock = s

    def send_json_line(self, payload: dict):
        """JSON 한 줄 전송 후 응답 한 줄 수신. (ok, response_dict_or_text)"""
        line = (json.dumps(payload, ensure_ascii=False) + '\n').encode('utf-8')
        with self.lock:
            for attempt in (1, 2):  # 끊겼으면 1회 재연결
                try:
                    if self.sock is None:
                        self._connect()
                    self.sock.sendall(line)
                    # 응답 한 줄 읽기
                    buf = b''
                    while b'\n' not in buf:
                        chunk = self.sock.recv(1024)
                        if not chunk:
                            raise ConnectionError('앱이 연결을 닫음')
                        buf += chunk
                    resp_text = buf.split(b'\n', 1)[0].decode('utf-8', 'replace')
                    try:
                        return True, json.loads(resp_text)
                    except json.JSONDecodeError:
                        return True, {'raw': resp_text}
                except Exception as e:
                    # 소켓 정리 후 재시도
                    try:
                        if self.sock:
                            self.sock.close()
                    except Exception:
                        pass
                    self.sock = None
                    if attempt == 2:
                        return False, {'error': str(e)}
        return False, {'error': 'unknown'}

    def close(self):
        with self.lock:
            if self.sock:
                try:
                    self.sock.close()
                except Exception:
                    pass
            self.sock = None


APP_SOCK = AppSocket(APP_PORT)


# --------------------------------------------------------------------------- #
#  HTTP 핸들러
# --------------------------------------------------------------------------- #
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
                'app_port': APP_PORT,
                'app_package': APP_PACKAGE,
            })
            return

        # ---- Device list ----
        if parsed.path == '/devices':
            if not ADB:
                self.send_json(500, {'ok': False, 'error': 'adb를 찾을 수 없습니다.'})
                return
            devices = list_devices()
            self.send_json(200, {'ok': True, 'devices': devices, 'count': len(devices)})
            return

        # ---- Setup: adb forward + appops ----
        if parsed.path == '/setup':
            if not ADB:
                self.send_json(500, {'ok': False, 'error': 'adb를 찾을 수 없습니다.'})
                return
            fwd_ok, fwd_out, fwd_err = setup_forward()
            ops_ok, ops_out, ops_err = setup_appops()
            self.send_json(200, {
                'ok': fwd_ok,
                'forward': {'ok': fwd_ok, 'stderr': fwd_err},
                'appops':  {'ok': ops_ok, 'stderr': ops_err},
                'app_package': APP_PACKAGE,
                'app_port': APP_PORT,
            })
            return

        # ---- Mock GPS (→ MnsMockGps 앱으로 TCP 전송) ----
        if parsed.path == '/mock-gps':
            try:
                lat = float(qs['lat'][0])
                lon = float(qs['lon'][0])
            except (KeyError, ValueError, IndexError):
                self.send_json(400, {'ok': False, 'error': 'lat, lon 파라미터 필요'})
                return

            # 선택 파라미터
            def fnum(key):
                try:
                    return float(qs[key][0]) if key in qs else None
                except (ValueError, IndexError):
                    return None

            bearing   = fnum('bearing')
            alt       = fnum('alt')
            accuracy  = fnum('accuracy')
            try:
                satellites = int(qs['satellites'][0]) if 'satellites' in qs else None
            except (ValueError, IndexError):
                satellites = None
            # 속도: speed_kmh(우선) 또는 speed(km/h) → 앱은 m/s 를 기대
            speed_kmh = fnum('speed_kmh')
            if speed_kmh is None:
                speed_kmh = fnum('speed')
            speed_ms = (speed_kmh * 1000.0 / 3600.0) if speed_kmh is not None else None

            # 앱 프로토콜 JSON 구성 (lat/lon 필수, 나머지 선택)
            payload = {'lat': lat, 'lon': lon}
            if bearing    is not None: payload['bearing']    = bearing
            if speed_ms   is not None: payload['speed']      = round(speed_ms, 3)
            if alt        is not None: payload['alt']        = alt
            if accuracy   is not None: payload['accuracy']   = accuracy
            if satellites is not None: payload['satellites'] = satellites

            ok, resp = APP_SOCK.send_json_line(payload)
            if not ok:
                self.send_json(502, {
                    'ok': False,
                    'error': f"앱 연결 실패: {resp.get('error', 'unknown')}",
                    'hint': 'MnsMockGps 앱이 실행 중인지, /setup 으로 adb forward 했는지 확인하세요.',
                    'sent': payload,
                })
                return

            app_ok = bool(resp.get('ok', False)) if isinstance(resp, dict) else False
            self.send_json(200 if app_ok else 500, {
                'ok': app_ok,
                'sent': payload,
                'app_response': resp,
                'lat': lat, 'lon': lon,
                **({'bearing': bearing} if bearing is not None else {}),
                **({'speed_kmh': speed_kmh} if speed_kmh is not None else {}),
                **({'accuracy': accuracy} if accuracy is not None else {}),
            })
            return

        self.send_json(404, {'error': 'Not found'})


# --------------------------------------------------------------------------- #
#  main
# --------------------------------------------------------------------------- #
if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='ADB Mock GPS Relay Server (MnsMockGps 연동)')
    parser.add_argument('--port', type=int, default=HTTP_PORT, help=f'HTTP 리스닝 포트 (기본값: {HTTP_PORT})')
    parser.add_argument('--app-port', type=int, default=APP_PORT, help=f'MnsMockGps 앱 TCP 포트 (기본값: {APP_PORT})')
    args = parser.parse_args()

    APP_PORT = args.app_port
    APP_SOCK = AppSocket(APP_PORT)

    if not ADB:
        print('⚠️  경고: adb를 찾지 못했습니다. PATH에 adb를 추가하거나 Android SDK를 설치하세요.')
    else:
        print(f'✅ adb 경로: {ADB}')
        # 시작 시 자동으로 adb forward + appops 설정 시도
        fwd_ok, _, fwd_err = setup_forward()
        print(f'   adb forward tcp:{APP_PORT} → {"OK" if fwd_ok else "실패: " + fwd_err}')
        ops_ok, _, ops_err = setup_appops()
        print(f'   모의위치 앱 지정({APP_PACKAGE}) → {"OK" if ops_ok else "실패: " + ops_err}')

    print(f'🚀 ADB Mock GPS Relay 서버 시작 (MnsMockGps 연동)')
    print(f'   HTTP   http://localhost:{args.port}/')
    print(f'   앱 TCP 127.0.0.1:{APP_PORT}  (com.mns.mockgps)')
    print(f'   테스트 http://localhost:{args.port}/mock-gps?lat=37.4979&lon=127.0276&bearing=90&speed_kmh=50')
    print('   Ctrl+C 로 종료\n')

    server = http.server.ThreadingHTTPServer(('127.0.0.1', args.port), RelayHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n서버 종료.')
        APP_SOCK.close()
