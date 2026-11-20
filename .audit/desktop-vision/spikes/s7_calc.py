"""S7: 계산기를 이름으로 누를 수 있는가. 이 스크립트가 연 계산기 창 하나만 만지고 닫는다."""
import os, subprocess, time
import uiautomation as auto

def calc_windows():
    return [w for w in auto.GetRootControl().GetChildren() if w.ClassName == "ApplicationFrameWindow" and ("계산기" in w.Name or "Calculator" in w.Name)]

before = {w.NativeWindowHandle for w in calc_windows()}
t = time.perf_counter()
subprocess.Popen([os.path.join(os.environ["SystemRoot"], "System32", "calc.exe")])
mine = None
for _ in range(50):
    time.sleep(0.2)
    new = [w for w in calc_windows() if w.NativeWindowHandle not in before]
    if new:
        mine = new[0]; break
print("found_new_window", mine is not None, "before", len(before), "ms", round((time.perf_counter()-t)*1000))
if mine:
    time.sleep(1.0)
    buttons = []
    def walk(c, depth=0):
        if depth > 12: return
        for ch in c.GetChildren():
            if ch.ControlTypeName == "ButtonControl":
                buttons.append((ch.Name, ch.AutomationId))
            walk(ch, depth + 1)
    t = time.perf_counter(); walk(mine); print("walk_ms", round((time.perf_counter()-t)*1000), "buttons", len(buttons))
    print("sample", buttons[:40])
    ids = {aid: name for name, aid in buttons}
    def press(aid):
        b = mine.ButtonControl(AutomationId=aid, searchDepth=12)
        b.GetInvokePattern().Invoke()
    try:
        for aid in ["num1Button", "plusButton", "num2Button", "equalButton"]:
            press(aid); time.sleep(0.15)
        disp = mine.TextControl(AutomationId="CalculatorResults", searchDepth=12)
        print("display", repr(disp.Name))
    except Exception as e:
        print("press_error", repr(e)[:200])
    mine.GetWindowPattern().Close()
    time.sleep(0.8)
    print("closed", all(w.NativeWindowHandle != mine.NativeWindowHandle for w in calc_windows()))
