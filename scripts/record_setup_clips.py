"""Record the bundled first-run prompts using the same GPT Live reader as the app."""
import subprocess
import sys
from pathlib import Path

if __name__ == "__main__":
    script = Path(__file__).with_name("record-setup-clips.ts")
    raise SystemExit(subprocess.call(["node", str(script), *sys.argv[1:]]))
