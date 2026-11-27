"""Render a controlled test of the isolated 불 onset cue on 부 and on a medial 불.

Run after reference_fit.py and reference_articulation.py. Keep the input listening
pack as the historical control; the separate proposed pack changes only isolated 불.
"""

import argparse
import base64
import hashlib
import io
import json
from pathlib import Path

import numpy as np
from scipy.io import wavfile

from reference_fit import (
    Analysis,
    fitting_error,
    read_render,
    render,
    wav_bytes,
    write_json,
)


def load(path):
    return json.loads(path.read_text(encoding="utf8"))


def listening_page(out, trials):
    labels = {"male": "남성", "female": "여성", "child": "아동"}
    clips = []
    for trial in trials:
        rate, pcm = wavfile.read(out / trial["file"])
        samples = pcm.astype(float)
        hop = round(rate * 0.01)
        power = np.array(
            [np.mean(samples[i : i + hop] ** 2) for i in range(0, len(samples), hop)]
        )
        active = power[power > power.max() * 0.001]
        if not len(active):
            raise ValueError(f"Silent listening clip: {trial['file']}")
        clips.append((trial, rate, samples, np.sqrt(active.mean())))
    reference = min(rms for _, _, _, rms in clips)
    bank = []
    for trial, rate, samples, rms in clips:
        buffer = io.BytesIO()
        wavfile.write(buffer, rate, np.rint(samples * reference / rms).astype("<i2"))
        bank.append(
            dict(
                context=trial["context"],
                target=trial["target"],
                condition=trial["condition"],
                voice=labels[trial["voice"]],
                wav=base64.b64encode(buffer.getvalue()).decode("ascii"),
            )
        )
    data = json.dumps(bank, ensure_ascii=False, separators=(",", ":"))
    version = hashlib.sha256(data.encode()).hexdigest()[:16]
    template = (
        Path(__file__).with_name("onset_listening.html").read_text(encoding="utf8")
    )
    (out / "onset-transfer.html").write_text(
        template.replace("PACK_VERSION", version).replace("AUDIO_BANK", data),
        encoding="utf8",
    )


def lower_pitch(fit, onset):
    def shift(t, hz):
        weight = np.interp(
            t - onset, [-0.085, -0.020, 0.015, 0.060], [0, 1, 1, 0], left=0, right=0
        )
        return [t, hz * 2 ** (-3 * weight / 12)]

    return dict(fit, pitch=[shift(t, hz) for t, hz in fit["pitch"]])


def medial_u(spans):
    hits = [
        i
        for i in range(1, len(spans) - 1)
        if spans[i - 1]["ipa"] in ("p", "b")
        and spans[i]["ipa"] == "u"
        and spans[i + 1]["ipa"] == "l"
    ]
    if len(hits) != 1:
        raise ValueError("Expected one labial stop + /u/ + /l/ in the carrier sentence")
    return hits[0]


def vowel_anchor(take, vowel):
    # A medial [b] can already be periodic. Anchor to the first sustained periodic
    # frames inside the planned vowel and avoid treating its closure as positive VOT.
    for i in np.flatnonzero(
        (take.t >= vowel["start"]) & (take.t + 0.060 < vowel["end"])
    ):
        if np.all(take.hz[i : i + 3] > 0):
            return float(take.t[i])
    raise ValueError("Cannot locate sustained phonation in the target /u/")


def pitch_at(take, at, lo=0.015, hi=0.045):
    values = take.hz[(take.t >= at + lo) & (take.t <= at + hi) & (take.hz > 0)]
    if len(values) < 2:
        raise ValueError("Too few periodic frames for the pitch comparison")
    return round(float(np.median(values)), 1)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--work", type=Path, required=True)
    ap.add_argument("--pack", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()
    root, out = args.work, args.out
    out.mkdir(parents=True, exist_ok=True)
    if args.pack.resolve() == (out / "reference-proposed.json").resolve():
        ap.error("Keep the first listening pack as the input for this comparison")
    pack = load(args.pack)
    selected = load(root / "selected-controls.json")
    audit = load(root / "articulation-audit.json")
    names = ["불", "풀", "뿔"]
    spoken = ["부", "푸", "뿌"]
    jobs = []
    for v, info in pack["voices"].items():
        for j, word in enumerate(names):
            jobs.append(
                dict(
                    id=f"{v}-phrase-{j}",
                    text=f"저기 {word} 보여?",
                    voice=v,
                    fit=info["profile"],
                )
            )
        for i in (0, 3):
            row = info["rows"][i]
            take, _ = read_render(root, row["candidate"])
            base = next(
                f for name, f in selected.items() if name.startswith(f"{v}-{i}-")
            )
            if audit[v]["uMix"]:
                base = dict(base, vowels=audit[v]["lpcHz"], vowelMix=audit[v]["uMix"])
            for tag, fit in [
                ("control", base),
                ("lower", lower_pitch(base, take.onset)),
            ]:
                jobs.append(
                    dict(id=f"{v}-word-{i}-{tag}", text=row["text"], voice=v, fit=fit)
                )
    render(out, jobs)
    next_jobs = []
    for v, info in pack["voices"].items():
        base, spans = read_render(out, f"{v}-phrase-0")
        i = medial_u(spans)
        next_jobs.append(
            dict(
                id=f"{v}-phrase-lower",
                text="저기 불 보여?",
                voice=v,
                fit=info["profile"],
                lowerOnset=dict(vowel=i, at=vowel_anchor(base, spans[i])),
            )
        )
    render(out, next_jobs)
    trials, metrics = [], {}
    for v, info in pack["voices"].items():
        metrics[v] = {}
        for i in (0, 3):
            row = info["rows"][i]
            control, seg = read_render(out, f"{v}-word-{i}-control")
            lower, seg2 = read_render(out, f"{v}-word-{i}-lower")
            if (
                wav_bytes(control, False)
                != base64.b64decode(row["takes"]["after"]["wav"])
                or seg != seg2
            ):
                raise ValueError(
                    f"Current fit does not reproduce the listening control: {v} {i}"
                )
            value = wav_bytes(lower, False)
            (out / f"{v}-word-{i}-lower.wav").write_bytes(value)
            metrics[v][row["text"]] = dict(
                startHz=[pitch_at(a, a.onset) for a in (control, lower)],
                votMs=[round(1000 * a.vot) for a in (control, lower)],
                durationMs=[round(1000 * (a.end - a.start)) for a in (control, lower)],
            )
            if i == 3:
                sr, pcm = wavfile.read(root / f"{v}-3-original.wav")
                original = Analysis(pcm.astype(float) / 32768, sr)
                row["takes"]["after"] = dict(
                    lower.summary("불"),
                    rimeMs=round(1000 * (lower.end - lower.burst)),
                    wav=base64.b64encode(value).decode("ascii"),
                )
                row["candidate"] = f"{v}-word-3-lower"
                row["loweredOnset"] = True
                row["afterError"] = fitting_error(lower, original, "불")
        for j, word in enumerate(spoken):
            data = base64.b64decode(info["rows"][j]["takes"]["after"]["wav"])
            (out / f"{v}-word-{j}.wav").write_bytes(data)
            trials.append(
                dict(
                    voice=v,
                    context="단어",
                    target=word,
                    condition="기존",
                    file=f"{v}-word-{j}.wav",
                )
            )
        trials.append(
            dict(
                voice=v,
                context="단어",
                target="부",
                condition="시작 F0 낮춤",
                file=f"{v}-word-0-lower.wav",
            )
        )
        for j, word in enumerate(names + ["불"]):
            tag = str(j) if j < 3 else "lower"
            stem = f"{v}-phrase-{tag}"
            take, spans = read_render(out, stem)
            (out / (stem + ".wav")).write_bytes(wav_bytes(take, False))
            trials.append(
                dict(
                    voice=v,
                    context="문장",
                    target=word,
                    condition="기존" if j < 3 else "시작 F0 낮춤",
                    file=stem + ".wav",
                )
            )
            if j == 0:
                base, baseline_spans = take, spans
            elif j == 3:
                idx = medial_u(spans)
                start = spans[idx - 1]["start"]
                if (
                    spans != baseline_spans
                    or base.y.shape != take.y.shape
                    or not np.array_equal(
                        base.y[: int(start * take.rate)],
                        take.y[: int(start * take.rate)],
                    )
                ):
                    raise ValueError(
                        "Carrier timing or samples before the target changed"
                    )
                anchor = vowel_anchor(base, spans[idx])
                suffix = spans[idx + 2]["end"]
                metrics[v]["문장"] = dict(
                    startHz=[pitch_at(a, anchor) for a in (base, take)],
                    followingHz=[
                        pitch_at(a, suffix, 0.035, 0.075) for a in (base, take)
                    ],
                    anchor=anchor,
                    targetStart=start,
                    durationMs=round(1000 * len(take.y) / take.rate),
                )
        if any(m["startHz"][1] >= m["startHz"][0] for m in metrics[v].values()):
            raise ValueError(f"Candidate failed to lower the realized onset pitch: {v}")
    write_json(out / "reference-proposed.json", pack)
    write_json(out / "trials.json", trials)
    write_json(out / "metrics.json", metrics)
    listening_page(out, trials)


if __name__ == "__main__":
    main()
