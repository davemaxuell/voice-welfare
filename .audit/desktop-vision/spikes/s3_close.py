import comtypes.client
from urllib.parse import unquote
shell = comtypes.client.CreateObject("Shell.Application")
wins = shell.Windows()
for i in reversed(range(wins.Count)):
    w = wins.Item(i)
    if w is None: continue
    u = unquote(w.LocationURL or "")
    if "/Temp/cheongeum-s3-" in u:
        print("closing", u); w.Quit()
