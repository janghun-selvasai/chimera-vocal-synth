"""Compare the clear and adducted planners on native WAVs and 1 ms model traces."""

import argparse
import json
from pathlib import Path
import subprocess

import numpy as np

from analyze import samples
from reference_fit import Analysis


def stop_metrics(meta, audio, rate):
    segments = meta["plan"]["segments"]
    stop, vowel = next(
        (a, b) for a, b in zip(segments, segments[1:])
        if a["ipa"] == "p" and b["ipa"] == "u"
    )
    t = stop["t1"]
    p = np.asarray(meta["probes"])
    # Last opening of the measured constriction near the planned bilabial release.
    openings = np.flatnonzero((p[:-1, 1] == 0) & (p[1:, 1] > 0)) + 1
    near = openings[np.abs(p[openings, 0] - t) < 0.04]
    if len(near) != 1:
        raise ValueError("Expected one measured oral release")
    opening = p[near[0], 0]
    window = (p[:, 0] >= opening - 0.020) & (p[:, 0] < opening - 0.005)
    # Measure the target syllable alone so the preceding and following vowels
    # cannot be returned as its first sustained periodic region.
    first = round(stop["t0"] * rate)
    target = audio[first:round(vowel["t1"] * rate)]
    take = Analysis(target, rate, t - first / rate)
    result = dict(
        releaseMs=round(1000 * opening, 1),
        glottalCm2=round(float(np.median(p[window, 4])), 5),
        burstMs=round(1000 * (take.burst + first / rate), 1),
        periodicMs=round(1000 * (take.onset + first / rate), 1),
        votMs=round(1000 * take.vot, 1),
    )
    if stop == segments[0]:
        # Pre-roll before the first stop: normalize to the same take's vowel.
        prefix = audio[:round(stop["t0"] * rate)]
        steady = audio[round((t + 0.07) * rate):round((t + 0.12) * rate)]
        result["preStopPeakDb"] = round(float(20 * np.log10(
            max(np.max(np.abs(prefix)), 1 / 32768) / np.max(np.abs(steady)))), 1)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli", type=Path, default=Path("target/release/chimera"))
    parser.add_argument("--originals", type=Path, help="Local reference_fit word clips")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    rows = []
    for voice in ["male", "female", "child"]:
        for word, text, ref in [
            ("ppu", "뿌", 2), ("ppul", "뿔", 5), ("medial", "저기 뿔 보여?", None),
            ("bul", "저기 불 보여?", None), ("pul", "저기 풀 보여?", None),
            ("sentence", "같이 먹어?", None),
        ]:
            row = dict(voice=voice, text=text)
            for condition in ["clear", "adducted"]:
                path = args.out / f"{voice}-{word}-{condition}.wav"
                subprocess.run([args.cli.resolve(), "render", "korean", path, text, voice,
                                condition, "--trace"], check=True, stdout=subprocess.DEVNULL)
                meta = json.loads(path.with_suffix(".json").read_text(encoding="utf8"))
                y, rate = samples(path)
                if np.max(np.abs(y)) >= 1 or np.ptp(y) == 0:
                    raise ValueError(f"Clipped or silent: {path}")
                if condition == "clear":
                    control = path.read_bytes()
                    segments = meta["plan"]["segments"]
                elif segments != meta["plan"]["segments"]:
                    raise ValueError("Oral segment times changed")
                if word in {"ppu", "ppul", "medial"}:
                    row[condition] = stop_metrics(meta, y, rate)
                elif condition == "adducted":
                    if path.read_bytes() != control:
                        raise ValueError(f"Control output changed: {path}")
                    row["identicalWav"] = True
            if ref is not None and args.originals:
                y, rate = samples(args.originals / f"{voice}-{ref}-original.wav")
                row["recordedVotMs"] = round(1000 * Analysis(y, rate).vot, 1)
            rows.append(row)
    (args.out / "measures.json").write_text(
        json.dumps(rows, indent=2, ensure_ascii=False), encoding="utf8")


if __name__ == "__main__":
    main()
