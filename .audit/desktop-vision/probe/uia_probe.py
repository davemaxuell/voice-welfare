"""읽기 전용 확인: 파이썬에서 Windows UI Automation 트리를 읽을 수 있는가. 창을 열거나 누르지 않는다."""
import sys, time
import uiautomation as auto

t0 = time.perf_counter()
root = auto.GetRootControl()
tops = root.GetChildren()
print("python", sys.version.split()[0], "top-level windows:", len(tops), f"{(time.perf_counter()-t0)*1000:.0f} ms")
kinds = {}
for w in tops:
    kinds[w.ClassName] = kinds.get(w.ClassName, 0) + 1
print("explorer windows (CabinetWClass):", kinds.get("CabinetWClass", 0))
fg = auto.GetForegroundControl()
t1 = time.perf_counter()
n = 0
types = {}
def walk(c, depth):
    global n
    if depth > 12 or n > 3000:
        return
    for ch in c.GetChildren():
        n += 1
        types[ch.ControlTypeName] = types.get(ch.ControlTypeName, 0) + 1
        walk(ch, depth + 1)
walk(fg, 0)
print("foreground window class:", fg.ClassName, "controls:", n, f"{(time.perf_counter()-t1)*1000:.0f} ms")
print("control types:", dict(sorted(types.items(), key=lambda kv: -kv[1])[:8]))
