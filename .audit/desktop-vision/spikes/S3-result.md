# S3 Shell COM (2026-11-18, this PC, Windows 11 Pro 10.0.26300, comtypes, Python 3.13)

{'windows_cold_ms': 46.2 (first ever run 481.9), 'windows_warm_ms': 12.9, 'found_own_window': True, 'navigate_normal_ok': True,
 'navigate_normal_ms': 429.4, 'select_ok': True, 'minimized': True, 'navigate_minimized_ok': True, 'thread_found': 1,
 'thread_ms': 104.8, 'thread_nav_ok': True, 'downloads_exists': True, 'closed': True}

- `explorer.exe <folder>` opened a NEW window (own HWND), not a tab in the owner's windows.
- `w.Document.Folder.Self` raises AttributeError under comtypes (base Folder interface). Use `LocationURL` (file:/// URL, percent-encoded) instead.
- Navigate2 and SelectItem(1|4|8|16) work on a minimized window and from a worker thread with CoInitialize.
- Windows 11 tabs: not tested (needs keyboard). Shell.Windows lists one entry per tab with the same HWND (documented, unmeasured).
- Decision: window follows by Navigate2, best effort. Listing stays os.scandir.
