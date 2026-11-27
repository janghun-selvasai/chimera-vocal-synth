"""Score native Korean Speak's final timeline against the frozen phone sequences."""
import argparse
from hashlib import sha256
import json
from pathlib import Path
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    fixture = Path(__file__).resolve().parents[2] / "crates/chimera/tests/korean-standard-50.json"
    dataset = json.loads(fixture.read_text(encoding="utf8"))
    results = []
    with tempfile.TemporaryDirectory() as tmp:
        take = Path(tmp) / "take"
        for group, cases in dataset["groups"].items():
            for text, hangul, expected, article in cases:
                subprocess.run([args.cli.resolve(), "render", "korean", take, text, "male", "clear", "--trace"],
                               check=True, stdout=subprocess.DEVNULL)
                trace = json.loads(take.with_suffix(".json").read_text(encoding="utf8"))
                actual = " ".join(s.get("displayIpa", s["ipa"]) for s in trace["plan"]["segments"])
                ok = actual == expected
                results.append(dict(group=group, text=text, standard=hangul, article=article,
                                    expected=expected, actual=actual, correct=ok,
                                    wavSHA256=sha256(take.with_suffix(".wav").read_bytes()).hexdigest()))
                if not ok:
                    print(f"{text} [{hangul}]  {actual}  !=  {expected}")
    assert len(results) == len({row["text"] for row in results}) == 50
    args.out.write_text(json.dumps(dict(corpusSHA256=sha256(fixture.read_bytes()).hexdigest(),
                                        results=results), ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    for group in dataset["groups"]:
        subset = [row for row in results if row["group"] == group]
        print(f"{group}  {sum(row['correct'] for row in subset)}/{len(subset)}")


if __name__ == "__main__":
    main()
