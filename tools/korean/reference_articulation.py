"""Second pass for the seven Korean prompts. Compare recorded vowel resonances and
protect consonant gestures when compressing the question. Uses the first pass's local pack.
"""

import argparse
import base64
import json
import re
import subprocess
from pathlib import Path

import numpy as np
from scipy import linalg, signal
from scipy.io import wavfile

from reference_fit import (
    Analysis,
    WORDS,
    alignment,
    fitting_error,
    make_fit,
    read_render,
    render,
    wav_bytes,
    write_json,
)


def recorded_formants(recording, times):
    x = signal.resample_poly(recording.y, 10000, recording.rate)
    estimates = []
    for t in times[::2]:
        mid = round(t * 10000)
        y = x[max(0, mid - 180) : mid + 180]
        if len(y) != 360:
            continue
        y = signal.lfilter([1, -0.96], [1], y) * np.hamming(len(y))
        ac = signal.correlate(y, y)[len(y) - 1 : len(y) + 12]
        if ac[0] < 1e-8:
            continue
        roots = np.roots(np.r_[1, -linalg.solve_toeplitz(ac[:12], ac[1:])])
        hz = np.angle(roots) * 10000 / (2 * np.pi)
        bw = -10000 / np.pi * np.log(np.abs(roots))
        poles = sorted(hz[(hz > 180) & (hz < 4000) & (bw < 650)])
        if len(poles) >= 2 and poles[0] < 1050 and poles[1] > poles[0] + 250:
            estimates.append(poles[:2])
    if len(estimates) < 3:
        return None
    return np.median(estimates, axis=0).round().tolist()


def sentence_timing(a, b, segments, profile, method):
    fit = make_fit(a, b, segments, profile, WORDS[-1])
    times = np.array([segments[0]["start"]] + [s["end"] for s in segments])
    orig = np.diff(times)
    if [s["ipa"] for s in segments] != ["k", "a", "tɕ", "i", "m", "ʌ", "g", "ʌ"]:
        raise ValueError("This timing experiment expects the current 같이 먹어? plan")
    src, dst = np.transpose(fit["time"])
    local = np.interp(times, src, dst)
    ratio = (b.end - b.start) / (a.end - a.start)
    wanted = (
        orig * ratio
        if method == "uniform"
        else 0.45 * orig * ratio + 0.55 * np.diff(local)
    )
    # Retain enough time to close the initial stop, make /tɕ/ and seal the lips for /m/.
    floor = np.array([0.065, 0.065, 0.075, 0.065, 0.055, 0.07, 0.04, 0.09])
    extra = np.maximum(0, wanted - floor)
    remaining = max(0.012, orig.sum() * ratio - sum(floor))
    ds = floor + extra * remaining / max(1e-6, sum(extra))
    starts = np.r_[times[0], times[0] + np.cumsum(ds)]
    shift = starts[1] - b.burst - (a.start - b.start)
    return dict(
        fit,
        time=[[0.0, 0.0]] + np.c_[times, starts].tolist(),
        adaptSpeed=True,
        pitch=[[float(t + shift), hz] for t, hz in fit["pitch"]],
    )


def transcribe(a, root, cli, model):
    path = root / "sentence-guard.wav"
    path.write_bytes(wav_bytes(a, False))
    pcm = root / "sentence-guard-16k.wav"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-i",
            str(path),
            "-af",
            "apad=whole_dur=1.2",
            "-ar",
            "16000",
            str(pcm),
        ],
        check=True,
    )
    stem = root / "sentence-guard"
    subprocess.run(
        [
            str(cli),
            "-m",
            str(model),
            "-l",
            "ko",
            "-t",
            "3",
            "-bs",
            "5",
            "-nf",
            "-nt",
            "-otxt",
            "-of",
            str(stem),
            str(pcm),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return stem.with_suffix(".txt").read_text(encoding="utf8").strip()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--work", required=True, type=Path)
    ap.add_argument("--pack", required=True, type=Path)
    ap.add_argument("--whisper-cli", type=Path)
    ap.add_argument("--whisper-model", type=Path)
    args = ap.parse_args()
    if bool(args.whisper_cli) != bool(args.whisper_model):
        ap.error("Supply both Whisper paths or neither")
    root = args.work
    pack = json.loads(args.pack.read_text(encoding="utf8"))
    summary = json.loads((root / "measurements.json").read_text(encoding="utf8"))
    chosen = json.loads((root / "selected-controls.json").read_text(encoding="utf8"))
    audit = {}
    for voice, data in pack["voices"].items():

        def original(i):
            rate, y = wavfile.read(root / f"{voice}-{i}-original.wav")
            return Analysis(y.astype(float) / 32768, rate)

        def export(i, which, take, err):
            row = data["rows"][i]
            audio = wav_bytes(take, False)
            (root / f"{voice}-{i}-after.wav").write_bytes(audio)
            metrics = take.summary(WORDS[i])
            if i != 6:
                metrics["rimeMs"] = round(1000 * (take.end - take.burst))
            row["takes"]["after"] = {
                **metrics,
                "wav": base64.b64encode(audio).decode("ascii"),
            }
            row["afterError"] = err
            row["candidate"] = which
            small = summary[voice]["rows"][i]
            small.update(candidate=which, afterError=err)
            small["takes"]["after"] = {k: v for k, v in metrics.items() if k != "f0"}

        base_names = [
            next(key for key in chosen if key.startswith(f"{voice}-{i}-"))
            for i in range(6)
        ]
        refs = [original(i) for i in range(7)]
        b = refs[-1]
        base, segments = read_render(root, f"{voice}-6-base")
        jobs = []
        for method in ["uniform", "protected"]:
            jobs.append(
                dict(
                    id=f"{voice}-6-{method}",
                    text=WORDS[-1],
                    voice=voice,
                    fit=sentence_timing(base, b, segments, data["profile"], method),
                )
            )
        render(root, jobs)
        initial, _ = read_render(root, jobs[0]["id"])
        at, bt, _ = alignment(initial, b)
        _, spans = read_render(root, jobs[0]["id"])
        points = {}
        for seg in spans:
            if seg["kind"] != "vowel":
                continue
            width = seg["end"] - seg["start"]
            selected = (at > seg["start"] + 0.25 * width) & (
                at < seg["end"] - 0.10 * width
            )
            indices = np.unique(np.rint(bt[selected] / 0.005).astype(int))
            indices = indices[(b.hz[indices] > 0) & (b.db[indices] > -19)]
            points.setdefault(seg["ipa"], []).extend(b.t[indices])
        formants = {
            k: f for k, t in points.items() if (f := recorded_formants(b, np.array(t)))
        }
        u = refs[0]
        times = u.t[
            (u.hz > 0) & (u.db > -18) & (u.t > u.onset + 0.025) & (u.t < u.end - 0.045)
        ]
        goal_u = recorded_formants(u, times)
        if goal_u:
            formants["u"] = goal_u
        vowels_jobs = []
        for job in jobs:
            for mix in [0.55, 0.9]:
                vowels_jobs.append(
                    dict(
                        job,
                        id=job["id"] + f"-v{mix}",
                        fit=dict(job["fit"], vowels=formants, vowelMix=mix),
                    )
                )
        for i in range(6):
            current = base_names[i]
            for mix in [0.55, 0.9]:
                vowels_jobs.append(
                    dict(
                        id=f"{voice}-{i}-v{mix}",
                        text=WORDS[i],
                        voice=voice,
                        fit=dict(chosen[current], vowels=formants, vowelMix=mix),
                    )
                )
        render(root, vowels_jobs)
        audit[voice] = {"lpcHz": formants, "sentence": []}
        # Use one rounded-vowel correction for both triplets, accepted on the open /pu/ calibration word.
        first, _ = read_render(root, base_names[0])
        calibration = fitting_error(first, refs[0], WORDS[0])
        selector = [(calibration["spectrumDb"], 0.0)]
        for mix in [0.55, 0.9]:
            trial, _ = read_render(root, f"{voice}-0-v{mix}")
            e = fitting_error(trial, refs[0], WORDS[0])
            if (
                e["lagMs"] <= calibration["lagMs"] + 5
                and e["spanMs"] <= calibration["spanMs"] + 25
            ):
                selector.append((e["spectrumDb"] + 0.1, mix))
        mix = min(selector)[1]
        audit[voice]["uMix"] = mix
        for i in range(6):
            name = f"{voice}-{i}-v{mix}" if mix else base_names[i]
            trial, _ = read_render(root, name)
            export(i, name, trial, fitting_error(trial, refs[i], WORDS[i]))
        opts = []
        for job in jobs + [j for j in vowels_jobs if j["text"] == WORDS[-1]]:
            name = job["id"]
            candidate, _ = read_render(root, name)
            e = fitting_error(candidate, b, WORDS[-1])
            heard = (
                transcribe(candidate, root, args.whisper_cli, args.whisper_model)
                if args.whisper_cli
                else ""
            )
            exact = re.sub(r"[^가-힣]", "", heard) == "같이먹어"
            audit[voice]["sentence"].append({"id": name, "asr": heard, "errors": e})
            cost = e["spanMs"] / 40 + e["pitchSt"] + 0.45 * e["spectrumDb"]
            opts.append((not exact, cost, name, candidate, e))
        _, _, name, final, err = min(opts, key=lambda q: q[:2])
        export(6, name, final, err)
        print(voice, formants, "/u/ mix", mix, "sentence", name, flush=True)
    write_json(args.pack, pack)
    write_json(root / "measurements.json", summary)
    write_json(root / "articulation-audit.json", audit)


if __name__ == "__main__":
    main()
