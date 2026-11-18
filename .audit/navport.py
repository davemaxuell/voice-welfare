"""Port feat/navigation (src/ieum, uncommitted, base e844479) into the main checkout's src/cheongeum.

For each changed file: base = e844479 version, theirs = nav worktree version, both renamed the same way
the package rename did; ours = main checkout. 3-way merge with `git merge-file`. Prints a report.
Usage: python port.py [--apply]
"""
import subprocess
import sys
from pathlib import Path

MAIN = Path(r"C:\Users\user\Desktop\voice-welfare")
NAV = Path(r"C:\Users\user\Desktop\voice-welfare-nav")
TMP = Path(__file__).parent / "evidence" / "navport"
BASE_REV = "e844479"
APPLY = "--apply" in sys.argv


def rename(text: str) -> str:
    return text.replace("ieum", "cheongeum").replace("IEUM", "CHEONGEUM").replace("이음", "청음")


def lf(text: str) -> str:
    return text.replace("\r\n", "\n")


def restore_eol(text: str, like: str) -> str:
    return text.replace("\n", "\r\n") if "\r\n" in like else text


def git(*args: str, cwd: Path = MAIN) -> bytes:
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, check=True).stdout


def changed_files() -> tuple[list[str], list[str]]:
    out = git("status", "--porcelain", "--untracked-files=all", cwd=NAV).decode("utf-8")
    modified, added = [], []
    for line in out.splitlines():
        code, path = line[:2], line[3:].strip().strip('"')
        if path.startswith(".audit/") or "__pycache__" in path:
            continue
        (added if code == "??" else modified).append(path)
    return modified, added


def main() -> None:
    TMP.mkdir(parents=True, exist_ok=True)
    modified, added = changed_files()
    report = []
    for path in modified + added:
        dest_rel = rename(path)
        dest = MAIN / dest_rel
        theirs = rename((NAV / path).read_bytes().decode("utf-8"))
        if path in added:
            if dest.exists():
                report.append(("EXISTS", dest_rel))
                continue
            if APPLY:
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(theirs.encode("utf-8"))
            report.append(("NEW", dest_rel))
            continue
        base = lf(rename(git("show", f"{BASE_REV}:{path}").decode("utf-8")))
        if not dest.exists():
            report.append(("MISSING_OURS", dest_rel))
            continue
        ours_raw = dest.read_bytes().decode("utf-8")
        ours, theirs = lf(ours_raw), lf(theirs)
        if ours == base:
            if APPLY:
                dest.write_bytes(restore_eol(theirs, ours_raw).encode("utf-8"))
            report.append(("TAKE_THEIRS", dest_rel))
            continue
        if theirs == base:
            report.append(("NOOP", dest_rel))
            continue
        stem = dest_rel.replace("/", "__")
        for name, text in (("ours", ours), ("base", base), ("theirs", theirs)):
            (TMP / f"{stem}.{name}").write_bytes(text.encode("utf-8"))
        proc = subprocess.run(
            ["git", "merge-file", "-p", "-L", "main", "-L", "base", "-L", "nav",
             str(TMP / f"{stem}.ours"), str(TMP / f"{stem}.base"), str(TMP / f"{stem}.theirs")],
            capture_output=True,
        )
        conflicts = proc.returncode
        merged = restore_eol(proc.stdout.decode("utf-8"), ours_raw).encode("utf-8")
        (TMP / f"{stem}.merged").write_bytes(merged)
        if APPLY:
            dest.write_bytes(merged)
        report.append((f"MERGED conflicts={conflicts}", dest_rel))
    for status, rel in report:
        print(f"{status:22} {rel}")


if __name__ == "__main__":
    main()
