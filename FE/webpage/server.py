#!/usr/bin/env python3
"""NeckCare dev server: 웹페이지 정적 파일 호스팅.

index.html, CSS, JS, SVG를 이 폴더에서 그대로 제공한다. 데이터 저장·통계는 Flask 백엔드(127.0.0.1:5000)가 맡는다.
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class Handler(SimpleHTTPRequestHandler):
    # 이 서버는 정적 파일만 제공한다. POST로 받는 API는 없다.
    def do_POST(self):
        self.send_response(404)
        self.end_headers()

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
