"""Render the Korean speech experiment. Run from the repository root with Python 3."""

import argparse
import subprocess
from pathlib import Path

WORDS = {"bul": "불", "pul": "풀", "ppul": "뿔", "dal": "달", "tal": "탈", "ttal": "딸"}
RULES = {
    "meogeo": "먹어",
    "gachi": "같이",
    "gungmul": "국물",
    "joined": "옷 안",
    "paused": "옷, 안",
}
SENTENCES = {
    "statement": "불이 보여.",
    "question": "불이 보여?",
    "comma": "먹어, 같이 먹어.",
    "inside": "이 불이 보여.",
    "rules": "같이 국물을 먹어.",
}
CONDITIONS = ("baseline", "vot", "pitch", "full")


def trials():
    for key, text in WORDS.items():
        yield key, text, CONDITIONS
        yield (
            "context-" + key,
            "이 " + text + "이 보여.",
            ("baseline", "full", "medial"),
        )
    for key, text in RULES.items():
        yield key, text, ("baseline", "full")
    for key, text in SENTENCES.items():
        yield (
            key,
            text,
            ("baseline", "contour", "rhythm", "vot", "pitch", "full", "medial")
            if key == "inside"
            else ("baseline", "contour", "rhythm", "vot", "full"),
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    parser.add_argument("--cli", default="target/release/chimera")
    args = parser.parse_args()
    args.directory.mkdir(parents=True, exist_ok=True)
    for key, text, conditions in trials():
        for condition in conditions:
            subprocess.run(
                [
                    args.cli,
                    "render",
                    "korean",
                    str(args.directory / f"{key}-{condition}"),
                    text,
                    "male",
                    condition,
                    "--trace",
                ],
                check=True,
            )
