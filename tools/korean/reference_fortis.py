"""Blind listening study: advance only the negative lip-aperture target of medial ㅃ."""

import argparse
from pathlib import Path

import numpy as np

from reference_fit import read_render, render, wav_bytes, write_json
from reference_transfer import listening_page, load, medial_u


def sealed_interval(trace, midpoint):
    # orAreas[-1] is the model's terminal oral tube section. Zero area is a sealed
    # outlet. Bracket both transitions with the open frames on either side.
    time = np.array([frame["time"] for frame in trace])
    area = np.array([frame["outletAreaCm2"] for frame in trace])
    center = int(np.argmin(abs(time - midpoint)))
    if area[center] != 0 or not np.all(np.isfinite(area)) or np.any(area < 0):
        raise ValueError("Expected a physically sealed outlet within the target stop")
    left = np.flatnonzero(area[:center] > 0)
    right = np.flatnonzero(area[center:] > 0)
    if not len(left) or not len(right):
        raise ValueError("The lip seal needs open frames on both sides")
    a, b = int(left[-1]), center + int(right[0])
    start, end = (time[a] + time[a + 1]) / 2, (time[b - 1] + time[b]) / 2
    return {
        "closeMs": round(start * 1000, 1),
        "openMs": round(end * 1000, 1),
        "durationMs": round((end - start) * 1000, 1),
        "closeBracketMs": [round(t * 1000, 1) for t in time[a : a + 2]],
        "openBracketMs": [round(t * 1000, 1) for t in time[b - 1 : b + 1]],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--pack",
        type=Path,
        required=True,
        help="Reference pack with the three fitted voice profiles",
    )
    parser.add_argument(
        "--transfer",
        type=Path,
        required=True,
        help="Previous transfer study with its three sentence controls per voice",
    )
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    out = args.out
    out.mkdir(parents=True, exist_ok=True)
    voices = load(args.pack)["voices"]
    conditions = [
        ("불", "bul", None),
        ("풀", "pul", None),
        ("뿔", "ppul", 0),
        ("뿔", "ppul-long", 40),
    ]
    jobs = [
        dict(
            id=f"{v}-{code}",
            text=f"저기 {word} 보여?",
            voice=v,
            fit=data["profile"],
            **({"lipLeadMs": lead} if lead is not None else {}),
        )
        for v, data in voices.items()
        for word, code, lead in conditions
    ]
    render(out, jobs)
    metrics, trials = {}, []
    for voice in voices:
        for i, (word, code, lead) in enumerate(conditions):
            stem = f"{voice}-{code}"
            take, segments = read_render(out, stem)
            wav = wav_bytes(take, False)
            if (
                i < 3
                and wav != (args.transfer / f"{voice}-phrase-{i}.wav").read_bytes()
            ):
                raise ValueError(
                    f"{stem}: control differs from the prior listening study"
                )
            (out / (stem + ".wav")).write_bytes(wav)
            condition = "입술 폐쇄 연장" if lead else "기존"
            trials.append(
                dict(
                    voice=voice,
                    context="문장",
                    condition=condition,
                    target=word,
                    file=stem + ".wav",
                )
            )
            if lead is None:
                continue
            trace = load(out / (stem + ".json"))["lipTrace"]
            stop = segments[medial_u(segments) - 1]
            seal = sealed_interval(trace, (stop["start"] + stop["end"]) / 2)
            if lead == 0:
                metrics[voice] = {"control": seal}
                control, control_plan = take, segments
            else:
                base = metrics[voice]["control"]
                if (
                    segments != control_plan
                    or len(take.y) != len(control.y)
                    or take.rate != control.rate
                    or seal["openBracketMs"] != base["openBracketMs"]
                    or abs((seal["durationMs"] - base["durationMs"]) - lead) > 11
                ):
                    raise ValueError(
                        f"{stem}: closure or release outside the planned timing control"
                    )
                changed = np.flatnonzero(take.y != control.y)
                if (
                    not len(changed)
                    or changed[0] / take.rate
                    < segments[medial_u(segments) - 2]["start"]
                    or changed[0] / take.rate >= stop["start"]
                ):
                    raise ValueError(
                        f"{stem}: expected the first PCM change during the preceding vowel"
                    )
                metrics[voice].update(
                    candidate=seal,
                    pcmDifferenceStartsMs=round(1000 * changed[0] / take.rate, 1),
                    samples=len(take.y),
                    rate=take.rate,
                    plannedStopMs=round((stop["end"] - stop["start"]) * 1000),
                )
    write_json(out / "metrics.json", metrics)
    write_json(out / "trials.json", trials)
    listening_page(
        out,
        trials,
        filename="fortis-closure.html",
        title="문장 속 불·풀·뿔",
        export_name="문장-경음-폐쇄",
    )


if __name__ == "__main__":
    main()
