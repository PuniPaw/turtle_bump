#!/usr/bin/env python3
"""NeckCare dev server: 정적 파일 호스팅 + 아주 가벼운 WebRTC 시그널링 중계.

시그널링 서버는 PC(수신)와 폰(송신) 브라우저가 WebRTC로 직접 연결(P2P)하기 전에
offer/answer SDP를 방(room) 코드별로 아주 잠깐 들고 있다가 전달해 주는 역할만 한다.
연결이 맺어지고 나면 영상은 두 브라우저가 직접 주고받으며, 이 서버는 전혀 거치지 않는다.
메모리에만 보관하고(파일/DB 없음), 오래된 방은 주기적으로 비운다.
"""
import json
import sys
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOM_TTL_SEC = 10 * 60

_rooms = {}
_lock = threading.Lock()


def _cleanup_locked():
    now = time.time()
    stale = [code for code, room in _rooms.items() if now - room.get('ts', 0) > ROOM_TTL_SEC]
    for code in stale:
        del _rooms[code]


class Handler(SimpleHTTPRequestHandler):
    def _signal_target(self):
        path = self.path.split('?', 1)[0]
        parts = [p for p in path.split('/') if p]
        # ['api', 'signal', '<room>', '<offer|answer>']
        if len(parts) == 4 and parts[0] == 'api' and parts[1] == 'signal' and parts[3] in ('offer', 'answer'):
            return parts[2].upper(), parts[3]
        return None

    def do_GET(self):
        target = self._signal_target()
        if target is None:
            return super().do_GET()
        room, role = target
        with _lock:
            _cleanup_locked()
            data = _rooms.get(room, {}).get(role)
        if data is None:
            self.send_response(204)
            self.end_headers()
            return
        body = json.dumps(data).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        target = self._signal_target()
        if target is None:
            self.send_response(404)
            self.end_headers()
            return
        room, role = target
        length = int(self.headers.get('Content-Length', 0) or 0)
        raw = self.rfile.read(length) if length else b''
        try:
            payload = json.loads(raw or b'{}')
        except json.JSONDecodeError:
            self.send_response(400)
            self.end_headers()
            return
        with _lock:
            _cleanup_locked()
            entry = _rooms.setdefault(room, {})
            entry[role] = payload
            entry['ts'] = time.time()
        body = b'{"ok":true}'
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        super().log_message(fmt, *args)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5173
    directory = sys.argv[2] if len(sys.argv) > 2 else str(Path(__file__).resolve().parent)
    handler = partial(Handler, directory=directory)
    httpd = ThreadingHTTPServer(('127.0.0.1', port), handler)
    print(f'NeckCare server: http://127.0.0.1:{port} (static: {directory})')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
