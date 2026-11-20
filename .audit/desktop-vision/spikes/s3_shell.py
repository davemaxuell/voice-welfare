"""S3: Shell COM로 탐색기 창을 움직일 수 있는가. 이 스크립트가 연 창 하나만 만지고 닫는다."""
import ctypes
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import comtypes.client

root = Path(tempfile.mkdtemp(prefix="cheongeum-s3-"))
(root / "하위 폴더").mkdir()
for name in ["기초연금 안내.pdf", "신청서.hwpx", "사진 1.jpg"]:
    (root / name).write_bytes(b"x")
(root / "하위 폴더" / "안쪽.txt").write_text("안쪽")

def url_path(w):
    from urllib.parse import unquote, urlparse
    try:
        u = w.LocationURL
    except Exception:
        return None
    if not u or not u.startswith("file:///"):
        return None
    return unquote(urlparse(u).path).lstrip("/").replace("/", "\\")

def norm(p: str) -> str:
    return os.path.normcase(os.path.abspath(p))

def shell_windows():
    shell = comtypes.client.CreateObject("Shell.Application")
    t = time.perf_counter()
    wins = shell.Windows()
    out = []
    for i in range(wins.Count):
        w = wins.Item(i)
        if w is None:
            continue
        path = url_path(w)
        out.append((w, path))
    return out, (time.perf_counter() - t) * 1000

def find_mine(target: Path, timeout=8.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        wins, ms = shell_windows()
        for w, path in wins:
            if path and norm(path) == norm(str(target)):
                return w, ms
        time.sleep(0.3)
    return None, None

report = {}
_, cold = shell_windows()
report["windows_cold_ms"] = round(cold, 1)
_, warm = shell_windows()
report["windows_warm_ms"] = round(warm, 1)

subprocess.Popen(["explorer.exe", str(root)])
w, ms = find_mine(root)
report["found_own_window"] = w is not None
if w is None:
    print(report)
    sys.exit(1)
hwnd = w.HWND
report["hwnd"] = hwnd

t = time.perf_counter()
w.Navigate2(str(root / "하위 폴더"))
ok = False
for _ in range(30):
    time.sleep(0.1)
    try:
        if norm(url_path(w) or '') == norm(str(root / "하위 폴더")):
            ok = True
            break
    except Exception:
        pass
report["navigate_normal_ok"] = ok
report["navigate_normal_ms"] = round((time.perf_counter() - t) * 1000, 1)

w.Navigate2(str(root))
time.sleep(1.0)
# 파일 하나 고르기: 1 선택 | 4 다른 것 해제 | 8 보이게 | 16 초점
doc = w.Document
item = doc.Folder.ParseName("신청서.hwpx")
try:
    doc.SelectItem(item, 1 | 4 | 8 | 16)
    time.sleep(0.3)
    sel = doc.SelectedItems()
    report["select_ok"] = sel.Count == 1 and sel.Item(0).Name.startswith("신청서")
except Exception as e:
    report["select_ok"] = f"error {e!r}"

# 최소화한 창에서도 따라오는가
SW_MINIMIZE, SW_RESTORE = 6, 9
ctypes.windll.user32.ShowWindow(hwnd, SW_MINIMIZE)
time.sleep(0.6)
report["minimized"] = bool(ctypes.windll.user32.IsIconic(hwnd))
w.Navigate2(str(root / "하위 폴더"))
ok = False
for _ in range(30):
    time.sleep(0.1)
    try:
        if norm(url_path(w) or '') == norm(str(root / "하위 폴더")):
            ok = True
            break
    except Exception:
        pass
report["navigate_minimized_ok"] = ok

# 다른 스레드(서버의 작업 스레드 흉내)에서 같은 일을 할 수 있는가
import threading
res = {}
def worker():
    import comtypes
    comtypes.CoInitialize()
    try:
        ws, ms = shell_windows()
        mine = [x for x, p in ws if p and norm(p).startswith(norm(str(root)))]
        res["thread_found"] = len(mine)
        res["thread_ms"] = round(ms, 1)
        if mine:
            mine[0].Navigate2(str(root))
            time.sleep(1.0)
            res["thread_nav_ok"] = norm(url_path(mine[0]) or '') == norm(str(root))
    finally:
        comtypes.CoUninitialize()
th = threading.Thread(target=worker)
th.start()
th.join(15)
report.update(res)

# 알려진 폴더 경로(다운로드)
from ctypes import wintypes
class GUID(ctypes.Structure):
    _fields_ = [("Data1", wintypes.DWORD), ("Data2", wintypes.WORD), ("Data3", wintypes.WORD), ("Data4", ctypes.c_ubyte * 8)]
def known(guid: str) -> str:
    g = GUID()
    ctypes.oledll.ole32.CLSIDFromString(guid, ctypes.byref(g))
    p = ctypes.c_wchar_p()
    ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(g), 0, None, ctypes.byref(p))
    v = p.value
    ctypes.windll.ole32.CoTaskMemFree(p)
    return v
report["downloads_exists"] = os.path.isdir(known("{374DE290-123F-4565-9164-39C4925E467B}"))

ctypes.windll.user32.ShowWindow(hwnd, SW_RESTORE)
w.Quit()
time.sleep(0.5)
report["closed"] = find_mine(root, timeout=1.0)[0] is None
print(report)
