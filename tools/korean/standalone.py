"""Bundle the Korean speech studio and its physical engine for use from a local file."""

import base64
import re
import subprocess
import sys
from pathlib import Path


def encode(data):
    return base64.b64encode(data).decode("ascii")


def bundle(entry, *options):
    return subprocess.check_output([
        "bun", "build", entry, "--target", "browser", "--format", "iife", "--minify", *options
    ])


output = Path(sys.argv[1])
script = bundle("src/korean/lab.ts", "--external", "*.wasm?url", "--external", "*?worker&url")
processor = bundle("src/worklet/processor.ts")
html = Path("korean.html").read_text(encoding="utf8")
style = Path("src/korean/lab.css").read_text(encoding="utf8")
wasm = encode(Path("src/wasm/chimera.wasm").read_bytes())
scripts = (
    '<script type="application/octet-stream" id="worklet-data">' + encode(processor) + "</script>"
    '<script type="application/octet-stream" id="engine-data">' + wasm + "</script>"
    "<script>" + script.decode().replace("</script", r"<\/script") + "</script>"
)
html, styles = re.subn(r'<link\b[^>]*href="/src/korean/lab\.css"[^>]*>', lambda _: "<style>" + style + "</style>", html)
html, entries = re.subn(r'<script\b[^>]*src="/src/korean/lab\.ts"[^>]*>\s*</script>', lambda _: scripts, html)
if (styles, entries) != (1, 1):
    raise ValueError("Korean studio HTML entry or stylesheet changed")
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(html, encoding="utf8")
