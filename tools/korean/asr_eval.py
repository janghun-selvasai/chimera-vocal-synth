"""Optional independent Korean transcription check. Uses local whisper.cpp and FFmpeg."""

import argparse
import csv
import re
import subprocess
from pathlib import Path

from render import CONDITIONS, SENTENCES, WORDS

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for key in ("renders", "scratch", "csv", "cli", "model"):
        parser.add_argument(key, type=Path)
    args = parser.parse_args()
    args.scratch.mkdir(parents=True, exist_ok=True)
    rows = []
    for key, text in {**WORDS, **SENTENCES}.items():
        for c in CONDITIONS if key in WORDS else ("baseline", "full"):
            stem = args.scratch / f"{key}-{c}"
            f = stem.with_suffix(".wav")
            subprocess.run(
                [
                    "ffmpeg",
                    "-loglevel",
                    "error",
                    "-y",
                    "-i",
                    str(args.renders / f"{key}-{c}.wav"),
                    "-af",
                    "apad=whole_dur=1.2",
                    "-ar",
                    "16000",
                    "-ac",
                    "1",
                    str(f),
                ],
                check=True,
            )
            subprocess.run(
                [
                    str(args.cli),
                    "-m",
                    str(args.model),
                    "-l",
                    "ko",
                    "-t",
                    "4",
                    "-bs",
                    "5",
                    "-nf",
                    "-nt",
                    "-otxt",
                    "-of",
                    str(stem),
                    str(f),
                ],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            transcript = stem.with_suffix(".txt").read_text(encoding="utf8").strip()
            normalize = lambda s: re.sub(r"[^가-힣]", "", s)
            rows.append(
                [
                    key,
                    c,
                    text,
                    transcript,
                    int(normalize(text) == normalize(transcript)),
                ]
            )
            print(key, c, repr(transcript), flush=True)
    with args.csv.open("w", encoding="utf-8-sig", newline="") as dest:
        writer = csv.writer(dest)
        writer.writerow(["id", "condition", "reference", "whisper", "exact_match"])
        writer.writerows(rows)
