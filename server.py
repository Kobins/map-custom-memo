#!/usr/bin/env python3
import json
import os
import re
import secrets
import sys
import threading
import time
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT_DIR = Path(__file__).resolve().parent
PROJECTS_DIR = ROOT_DIR / "projects"
ASSETS_DIR = PROJECTS_DIR / "assets"
LIVE_RELOAD_TARGETS = ("index.html", "app.js", "styles.css")


def ensure_dirs() -> None:
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    ASSETS_DIR.mkdir(parents=True, exist_ok=True)


def sanitize_project_filename(raw_name: str) -> str:
    name = os.path.basename(unquote(raw_name or "").strip())
    if not name:
        raise ValueError("프로젝트 파일명이 비어 있습니다.")
    if not name.endswith(".mapproj"):
        name = f"{name}.mapproj"
    return name


def project_path_from_name(raw_name: str) -> Path:
    file_name = sanitize_project_filename(raw_name)
    return PROJECTS_DIR / file_name


def sanitize_asset_filename(raw_name: str) -> str:
    fallback = "map"
    decoded = os.path.basename(raw_name or fallback)
    stem = Path(decoded).stem or fallback
    suffix = Path(decoded).suffix.lower()
    stem = re.sub(r"[^0-9A-Za-z가-힣._-]+", "_", stem).strip("._")
    if not stem:
        stem = fallback
    if len(stem) > 60:
        stem = stem[:60]
    if not suffix:
        suffix = ".bin"
    return f"{int(time.time())}_{secrets.token_hex(4)}_{stem}{suffix}"


def parse_multipart_image(content_type: str, body: bytes) -> tuple[str, bytes]:
    match = re.search(r'boundary="?([^";]+)"?', content_type)
    if not match:
        raise ValueError("multipart boundary가 없습니다.")

    boundary = match.group(1).encode("utf-8")
    boundary_mark = b"--" + boundary
    parts = body.split(boundary_mark)

    for raw_part in parts:
        part = raw_part.strip()
        if not part or part == b"--":
            continue
        if part.endswith(b"--"):
            part = part[:-2]
        part = part.strip(b"\r\n")

        header_blob, separator, payload = part.partition(b"\r\n\r\n")
        if not separator:
            continue

        header_text = header_blob.decode("utf-8", errors="replace")
        disposition_line = ""
        for line in header_text.split("\r\n"):
            if line.lower().startswith("content-disposition:"):
                disposition_line = line
                break
        if not disposition_line:
            continue

        name_match = re.search(r'name="([^"]+)"', disposition_line)
        file_match = re.search(r'filename="([^"]*)"', disposition_line)
        if not name_match or name_match.group(1) != "image" or not file_match:
            continue

        filename = file_match.group(1) or "map"
        file_bytes = payload.rstrip(b"\r\n")
        return filename, file_bytes

    raise ValueError("image 필드를 찾을 수 없습니다.")


class FileWatchHub:
    def __init__(self, files: tuple[str, ...], interval_sec: float = 0.5) -> None:
        self._paths = [ROOT_DIR / f for f in files]
        self._interval_sec = interval_sec
        self._cv = threading.Condition()
        self._version = 0
        self._running = False
        self._thread: threading.Thread | None = None
        self._last_mtime_ns: dict[Path, int | None] = {}

    @property
    def current_version(self) -> int:
        with self._cv:
            return self._version

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._last_mtime_ns = {path: self._safe_stat(path) for path in self._paths}
        self._thread = threading.Thread(target=self._watch_loop, name="live-reload-watch", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._running = False
        with self._cv:
            self._cv.notify_all()
        if self._thread:
            self._thread.join(timeout=1.0)
            self._thread = None

    def wait_for_update(self, last_version: int, timeout_sec: float = 15.0) -> int:
        with self._cv:
            if self._version <= last_version:
                self._cv.wait(timeout=timeout_sec)
            return self._version

    def _watch_loop(self) -> None:
        while self._running:
            if self._has_changes():
                with self._cv:
                    self._version += 1
                    self._cv.notify_all()
            time.sleep(self._interval_sec)

    def _has_changes(self) -> bool:
        changed = False
        for path in self._paths:
            current = self._safe_stat(path)
            previous = self._last_mtime_ns.get(path)
            if current != previous:
                self._last_mtime_ns[path] = current
                changed = True
        return changed

    @staticmethod
    def _safe_stat(path: Path) -> int | None:
        try:
            return path.stat().st_mtime_ns
        except FileNotFoundError:
            return None


LIVE_RELOAD = FileWatchHub(LIVE_RELOAD_TARGETS)


class MapMemoHandler(SimpleHTTPRequestHandler):
    def _send_json(self, payload: dict, status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length > 0 else b""
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def _handle_list_projects(self) -> None:
        files = sorted(p.name for p in PROJECTS_DIR.glob("*.mapproj"))
        self._send_json({"projects": files})

    def _handle_get_project(self, raw_name: str) -> None:
        path = project_path_from_name(raw_name)
        if not path.exists():
            self._send_json({"error": f"프로젝트를 찾을 수 없습니다: {path.name}"}, status=HTTPStatus.NOT_FOUND)
            return
        try:
            with path.open("r", encoding="utf-8") as f:
                data = json.load(f)
        except json.JSONDecodeError:
            self._send_json({"error": f"손상된 JSON 파일입니다: {path.name}"}, status=HTTPStatus.BAD_REQUEST)
            return
        self._send_json(data)

    def _handle_put_project(self, raw_name: str) -> None:
        try:
            payload = self._read_json_body()
        except json.JSONDecodeError:
            self._send_json({"error": "유효한 JSON 요청이 아닙니다."}, status=HTTPStatus.BAD_REQUEST)
            return

        if not isinstance(payload, dict):
            self._send_json({"error": "프로젝트 데이터는 JSON object 여야 합니다."}, status=HTTPStatus.BAD_REQUEST)
            return

        path = project_path_from_name(raw_name)
        with path.open("w", encoding="utf-8", newline="\n") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
            f.write("\n")
        self._send_json({"ok": True, "file": path.name})

    def _handle_upload_image(self) -> None:
        ctype = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in ctype:
            self._send_json({"error": "multipart/form-data 요청만 지원합니다."}, status=HTTPStatus.BAD_REQUEST)
            return

        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length > 0 else b""
        if not body:
            self._send_json({"error": "업로드된 파일이 비어 있습니다."}, status=HTTPStatus.BAD_REQUEST)
            return

        try:
            raw_name, data = parse_multipart_image(ctype, body)
        except ValueError as exc:
            self._send_json({"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
            return

        stored_name = sanitize_asset_filename(raw_name)
        destination = ASSETS_DIR / stored_name
        with destination.open("wb") as f:
            f.write(data)

        self._send_json({"ok": True, "path": f"/projects/assets/{stored_name}"})

    def _handle_live_reload_stream(self) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()

        version = LIVE_RELOAD.current_version
        try:
            while True:
                next_version = LIVE_RELOAD.wait_for_update(version, timeout_sec=15.0)
                if next_version != version:
                    payload = json.dumps({"version": next_version}, ensure_ascii=False)
                    self.wfile.write(f"event: reload\ndata: {payload}\n\n".encode("utf-8"))
                    self.wfile.flush()
                    version = next_version
                else:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            return

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        path = parsed.path

        if path == "/__live":
            self._handle_live_reload_stream()
            return
        if path == "/api/projects":
            self._handle_list_projects()
            return
        if path.startswith("/api/projects/"):
            self._handle_get_project(path.removeprefix("/api/projects/"))
            return

        super().do_GET()

    def do_PUT(self) -> None:
        parsed = urlsplit(self.path)
        path = parsed.path
        if path.startswith("/api/projects/"):
            self._handle_put_project(path.removeprefix("/api/projects/"))
            return
        self._send_json({"error": "지원하지 않는 PUT 경로입니다."}, status=HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        parsed = urlsplit(self.path)
        path = parsed.path
        if path == "/api/images":
            self._handle_upload_image()
            return
        self._send_json({"error": "지원하지 않는 POST 경로입니다."}, status=HTTPStatus.NOT_FOUND)


def main() -> None:
    ensure_dirs()
    LIVE_RELOAD.start()

    port = 4173
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            print("포트 번호가 잘못되었습니다. 기본값 4173을 사용합니다.")
            port = 4173

    server = ThreadingHTTPServer(("0.0.0.0", port), MapMemoHandler)
    print(f"Server running: http://localhost:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
    finally:
        LIVE_RELOAD.stop()
        server.server_close()


if __name__ == "__main__":
    main()
