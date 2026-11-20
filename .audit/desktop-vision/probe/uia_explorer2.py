"""읽기 전용: 열린 탐색기 창마다 구조를 센다. 이름은 찍지 않는다."""
import time
import uiautomation as auto

root = auto.GetRootControl()
for w in [w for w in root.GetChildren() if w.ClassName == "CabinetWClass"]:
    t = time.perf_counter()
    n = 0; types = {}; items = []
    def walk(c, depth):
        global n
        if depth > 25 or n > 4000:
            return
        for ch in c.GetChildren():
            n += 1
            k = ch.ControlTypeName
            types[k] = types.get(k, 0) + 1
            if k == "ListItemControl":
                items.append(ch)
            walk(ch, depth + 1)
    walk(w, 0)
    try:
        minimized = auto.IsIconic(w.NativeWindowHandle)
    except Exception as e:
        minimized = repr(e)
    print("minimized:", minimized, "controls:", n, f"{(time.perf_counter()-t)*1000:.0f} ms", "list items:", len(items))
    print("  types:", dict(sorted(types.items(), key=lambda kv: -kv[1])[:10]))
    if items:
        it = items[0]
        pats = []
        for p in ("GetInvokePattern", "GetSelectionItemPattern", "GetValuePattern", "GetScrollItemPattern"):
            try:
                if getattr(it, p)():
                    pats.append(p[3:-7])
            except Exception:
                pass
        print("  first item: name chars", len(it.Name), "runtime id", bool(it.GetRuntimeId()), "patterns", pats, "automationId", bool(it.AutomationId))
