import re, sys
from pathlib import Path
def facts(path):
    out = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if line.startswith("- 생성:") or "응답 지연" in line:
            continue
        m = re.match(r"- ([\w-]+): \d+ms \((\d+)회\)", line)
        out.append(f"count {m.group(1)} {m.group(2)}" if m else line)
    return sorted(out)
a, b = facts(sys.argv[1]), facts(sys.argv[2])
only_a = [x for x in a if x not in b]; only_b = [x for x in b if x not in a]
print("identical apart from timing" if not only_a and not only_b else f"baseline only: {only_a}\nnew only: {only_b}")
