"""Assemble the installed backend from a managed interpreter and the project's locked wheels."""
from __future__ import annotations

import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
WINDOWS = sys.platform == "win32"
MODELS = {
    "koelectra-ko-pii-ner": ("model_int8.onnx", "config.json", "tokenizer.json", "README.md"),
}


def copy_models(dest: Path) -> None:
    source = ROOT / "models"
    files = [Path("MODELS.md"), *(Path(model) / name for model, names in MODELS.items() for name in names)]
    for rel in files:
        if not (source / rel).is_file():
            raise SystemExit(f"Missing models/{rel}. Run: uv run python scripts/setup_local_models.py")
        (dest / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / rel, dest / rel)


def windows_crt() -> Path:
    # Use the app-local redistributables from Visual C++ Build Tools.
    if os.environ.get("VCToolsRedistDir"):
        roots = [Path(os.environ["VCToolsRedistDir"])]
    else:
        vswhere = Path(os.environ["ProgramFiles(x86)"]) / "Microsoft Visual Studio/Installer/vswhere.exe"
        if not vswhere.is_file():
            raise SystemExit("Install Visual Studio C++ Build Tools (x64) to package the Visual C++ runtime.")
        installations = subprocess.check_output(
            [vswhere, "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
             "-property", "installationPath", "-utf8"], encoding="utf-8",
        )
        roots = [v for line in installations.splitlines() for v in (Path(line) / "VC/Redist/MSVC").glob("*")]
    candidates = [d for root in roots for d in root.glob("x64/Microsoft.VC*.CRT") if (d / "msvcp140.dll").is_file()]
    if not candidates:
        raise SystemExit("The x64 Visual C++ redistributable DLLs are missing. Check VCToolsRedistDir.")
    return max(candidates, key=lambda d: tuple(map(int, re.findall(r"\d+", d.parents[1].name))))


def copy_python(dest: Path) -> tuple[Path, Path]:
    base = Path(sys.base_prefix)
    # site-packages is populated separately from a clean, non-editable production install.
    ignore = shutil.ignore_patterns("site-packages", "__pycache__", "*.pyc", "test", "ensurepip", "*.a")
    dest.mkdir()
    if WINDOWS:
        for file in [base / "python.exe", *base.glob("python*.dll"), base / "LICENSE.txt", *windows_crt().glob("*.dll")]:
            shutil.copy2(file, dest)
        shutil.copytree(base / "DLLs", dest / "DLLs", ignore=shutil.ignore_patterns("_test*.pyd"))
        shutil.copytree(base / "Lib", dest / "Lib", ignore=ignore)
        return dest / "python.exe", dest / "Lib/site-packages"

    (dest / "bin").mkdir()
    shutil.copy2(Path(sys._base_executable).resolve(), dest / "bin/python3")
    shutil.copytree(base / "lib", dest / "lib", ignore=ignore, symlinks=True)
    for file in base.glob("LICENSE*"):
        shutil.copy2(file, dest)
    return dest / "bin/python3", dest / "lib/python3.12/site-packages"


def copy_packages(site: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="cheongeum-wheels-") as tmp:
        venv = Path(tmp) / "env"
        env = {**os.environ, "UV_PROJECT_ENVIRONMENT": str(venv), "UV_LINK_MODE": "copy"}
        env.pop("VIRTUAL_ENV", None)
        subprocess.run([
            "uv", "sync", "--locked", "--no-dev", "--extra", "postgres", "--no-editable", "--python", sys._base_executable,
            "--reinstall-package", "cheongeum-voice-welfare-agent",
        ], cwd=ROOT, env=env, check=True)
        installed = venv / ("Lib/site-packages" if WINDOWS else "lib/python3.12/site-packages")
        # Do not ship developer paths (wheel origin records) or the venv's startup hook.
        ignore = shutil.ignore_patterns("__pycache__", "*.pyc", "direct_url.json", "uv_cache.json", "uv_build.json", "_virtualenv.*", ".env")
        shutil.copytree(installed, site, ignore=ignore, symlinks=not WINDOWS)


def copy_browsers(python: Path, dest: Path) -> None:
    # The locked Playwright CLI identifies the matching browser and helper revisions in its build cache.
    cmd = [python, "-I", "-B", "-m", "playwright", "install", "--no-shell", "chromium"]
    subprocess.run([*cmd, "--no-remove"], check=True)
    plan = subprocess.check_output([*cmd, "--dry-run"], encoding="utf-8")
    sources = [Path(line.split(":", 1)[1].strip()) for line in plan.splitlines() if line.strip().startswith("Install location:")]
    if not any(source.name.startswith("chromium-") for source in sources):
        raise SystemExit("Playwright did not report a Chromium install location.")
    for source in sources:
        shutil.copytree(source, dest / source.name, symlinks=not WINDOWS)


def main() -> None:
    runtime = Path(sys.argv[1]).resolve()
    arch = {"amd64": "x64", "x86_64": "x64", "arm64": "arm64"}.get(platform.machine().lower())
    if arch != sys.argv[2] or (WINDOWS and arch != "x64") or sys.platform not in ("win32", "darwin"):
        raise SystemExit("The Python interpreter must match the desktop installer architecture.")
    runtime.mkdir()  # electron-builder supplies a fresh output directory for each target
    copy_models(runtime / "models")
    python, site = copy_python(runtime / "python")
    copy_packages(site)
    copy_browsers(python, runtime / "browsers")


if __name__ == "__main__":
    main()
