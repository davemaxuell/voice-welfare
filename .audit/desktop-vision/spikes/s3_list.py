import comtypes.client
shell = comtypes.client.CreateObject("Shell.Application")
wins = shell.Windows()
for i in range(wins.Count):
    w = wins.Item(i)
    if w is None: continue
    try: p = w.Document.Folder.Self.Path
    except Exception as e: p = f"? {e!r}"[:80]
    try: url = w.LocationURL
    except Exception: url = "?"
    print(i, w.HWND, repr(p), repr(url)[:120])
