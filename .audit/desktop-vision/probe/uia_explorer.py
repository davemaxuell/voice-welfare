"""읽기 전용 확인: 이미 열려 있는 파일 탐색기 창의 구조. 이름은 찍지 않고 종류·개수·패턴만 찍는다."""
import time
import uiautomation as auto

root = auto.GetRootControl()
wins = [w for w in root.GetChildren() if w.ClassName == "CabinetWClass"]
print("explorer windows:", len(wins))
w = wins[0]
t = time.perf_counter()
n = 0
types = {}
named = 0
items = []
def walk(c, depth):
    global n, named
    if depth > 25 or n > 4000:
        return
    for ch in c.GetChildren():
        n += 1
        k = ch.ControlTypeName
        types[k] = types.get(k, 0) + 1
        if ch.Name:
            named += 1
        if k == "ListItemControl":
            items.append(ch)
        walk(ch, depth + 1)
walk(w, 0)
print("controls:", n, "named:", named, f"{(time.perf_counter()-t)*1000:.0f} ms")
print("types:", dict(sorted(types.items(), key=lambda kv: -kv[1])[:12]))
print("list items:", len(items))
if items:
    it = items[0]
    pats = [p for p in ("GetInvokePattern", "GetSelectionItemPattern", "GetValuePattern") if getattr(it, p, None) and getattr(it, p)()]
    print("first item: name length", len(it.Name), "runtime id", bool(it.GetRuntimeId()), "patterns", pats, "automation id present", bool(it.AutomationId))
