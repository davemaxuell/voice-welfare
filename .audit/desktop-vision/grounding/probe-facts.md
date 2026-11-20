# Facts measured on this PC (2026-11-18, Windows 11, Python 3.12.13)

Read-only probes. Scripts are in `../probe/`. Nothing was opened, clicked or restored.

- **Python can read the Windows UI Automation tree.** `uiautomation` (pure Python over comtypes, 2 packages) installed with `uv run --with uiautomation`. Listing 15 top-level windows took 643 ms on the first call (COM start-up). Walking the foreground window (18 controls) took 29 ms.
- **File Explorer windows are found by class name `CabinetWClass`.** Two were open.
- **A minimized window exposes only its title bar.** Both Explorer windows were minimized and each showed 7 controls (title bar, 3 buttons, menu bar) and 0 list items. Reading a window's content needs the window restored first.
- **Not measured:** the structure of a restored Explorer file list (control types, whether items carry Invoke or SelectionItem patterns, how many items are exposed when the list is virtualized), 한글 or PDF viewer trees, and how long a large window takes to walk. The first build unit must measure these on a test folder.
- **Not measured:** an OpenAI call with an image part and strict `json_schema`. `.env` was not read. The Chat Completions format for an image is a `content` list with `{"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}`.
- **Other facts from the repo:**
  - No Windows automation dependency exists today (`pywinauto`, `uiautomation`, `comtypes`, `pywin32` are all absent).
  - Playwright is 1.65.2, so `page.screenshot(mask=[locators], style=..., scale="css")` exists.
  - The filesystem can list a folder and `os.startfile(path)` can open a file with its default app without driving Explorer's window at all.
  - `agents/web/docs.py` already reads PDF and HWPX text from a file path. Old binary HWP is not readable.
