"""Inline the replay assets for an offline, single-file playback page."""

import base64
import subprocess
import sys
from pathlib import Path


def encode(file):
    return base64.b64encode(Path(file).read_bytes()).decode("ascii")


output = Path(sys.argv[1])
script = subprocess.check_output(
    [
        "bun",
        "build",
        "src/korean/lab.ts",
        "--target",
        "browser",
        "--format",
        "iife",
        "--minify",
        "--external",
        "*.wasm?url",
    ]
).decode()
html = Path("korean.html").read_text(encoding="utf8")
html = html.replace(
    '<link rel="stylesheet" href="/src/korean/lab.css">',
    "<style>" + Path("src/korean/lab.css").read_text(encoding="utf8") + "</style>",
)
html = html.replace(
    '<script type="module" src="/src/korean/lab.ts"></script>',
    '<script type="application/octet-stream" id="engine-data">'
    + encode("src/wasm/chimera.wasm")
    + "</script>"
    '<script type="application/octet-stream" id="session-data">'
    + encode("public/korean-lab/session.gz")
    + "</script>"
    "<script>" + script.replace("</script", r"<\/script") + "</script>",
)
output.write_text(html, encoding="utf8")
