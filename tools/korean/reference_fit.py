"""Fit the studio's physical gestures to seven prompted utterances from each supplied voice.

Run from the repository root after building WASM. Requires FFmpeg, Bun, NumPy and SciPy.
Inputs and listening packs are local artifacts. IDs are the order of the recording prompt.
"""

import argparse
import base64
import io
import json
import os
import shlex
import subprocess
import wave
from pathlib import Path

import numpy as np
from scipy import ndimage, signal
from scipy.io import wavfile

WORDS = ["부", "푸", "뿌", "불", "풀", "뿔", "같이 먹어?"]
PRESETS = {
    "male": (0.0, 0.0, 0.25),
    "female": (1.0, 0.0, 0.28),
    "child": (0.0, 1.0, 0.34),
}
HOP = 0.005


def runs(mask):
    edges = np.diff(np.r_[False, mask, False].astype(int))
    return list(zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)))


def level(samples, rate):
    hop = round(rate * HOP)
    windows = samples[: len(samples) // hop * hop].reshape(-1, hop)
    return np.sqrt(np.mean(windows**2, axis=1) + 1e-14), hop / rate


def split_recording(path):
    # Decode the actual stream, including MP3 frames inside a mislabelled PCM RIFF.
    raw = subprocess.check_output(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(path),
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            "-f",
            "wav",
            "-",
        ]
    )
    with wave.open(io.BytesIO(raw), "rb") as source:
        rate = source.getframerate()
        y = np.frombuffer(source.readframes(source.getnframes()), "<i2") / 32768.0
    rms, dt = level(y, rate)
    active = rms > max(
        np.percentile(rms, 98) * 0.018, np.percentile(rms, 12) * 4, 0.00035
    )
    intervals = []
    for a, b in runs(active):
        if intervals and (a - intervals[-1][1]) * dt < 0.33:
            intervals[-1][1] = b
        else:
            intervals.append([a, b])
    spans = [
        (max(0, a * dt - 0.085), min(len(y) / rate, b * dt + 0.105))
        for a, b in intervals
        if (b - a) * dt >= 0.105
    ]
    if len(spans) != len(WORDS):
        raise ValueError(
            f"{path.name}: found {len(spans)} intervals; expected seven separated prompts"
        )
    return [(y[round(a * rate) : round(b * rate)], rate, (a, b)) for a, b in spans]


class Analysis:
    def __init__(self, samples, rate, release_hint=None):
        self.y, self.rate = samples, rate
        x = signal.resample_poly(samples, 8000, rate)
        self.t = np.arange(0, len(x), 40) / 8000
        windows = np.lib.stride_tricks.sliding_window_view(np.pad(x, (160, 160)), 320)[
            ::40
        ][: len(self.t)]
        frames = windows - windows.mean(axis=1, keepdims=True)
        self.db = 10 * np.log10(np.mean(frames**2, axis=1) + 1e-12)
        self.db -= np.max(self.db)
        rms, dt = level(samples, rate)
        voiced_energy = rms > max(np.percentile(rms, 97) * 0.035, 0.00025)
        active = [
            (a, b)
            for a, b in runs(ndimage.binary_closing(voiced_energy, np.ones(5)))
            if b - a >= 2
        ]
        if not active:
            raise ValueError("No active speech found")
        self.start, self.end = active[0][0] * dt, active[-1][1] * dt
        power = np.abs(np.fft.rfft(frames * np.hanning(320), n=512)) ** 2
        bands = np.array([100, 250, 440, 680, 960, 1300, 1700, 2200, 2850, 3900])
        freq = np.fft.rfftfreq(512, 1 / 8000)
        logbands = np.stack(
            [
                10 * np.log10(power[:, (freq >= lo) & (freq < hi)].sum(axis=1) + 1e-10)
                for lo, hi in zip(bands, bands[1:])
            ],
            axis=1,
        )
        self.spectrum = np.clip(logbands - logbands.max(axis=1, keepdims=True), -46, 0)
        self.hz = np.zeros(len(frames))
        lags = np.arange(13, 126)
        for i in np.flatnonzero(self.db > -33):
            v = frames[i]
            ac = signal.correlate(v, v, method="fft")[319 + lags]
            energy = np.r_[0, np.cumsum(v * v)]
            ac /= np.sqrt(energy[-lags - 1] * (energy[-1] - energy[lags]) + 1e-20)
            peaks = signal.find_peaks(ac)[0]
            if not len(peaks):
                continue
            good = peaks[ac[peaks] >= max(0.68, ac[peaks].max() * 0.92)]
            if len(good):
                k = good[0]
                frac = (
                    0.5 * (ac[k - 1] - ac[k + 1]) / (ac[k - 1] - 2 * ac[k] + ac[k + 1])
                )
                self.hz[i] = 8000 / (lags[k] + frac)
        for a, b in runs(self.hz > 0):
            if b - a < 3:
                self.hz[a:b] = 0
        if np.count_nonzero(self.hz) < 5:
            raise ValueError("Too few periodic frames to fit the speaker")
        # Burst is a short rise in high-band energy. A plan hint excludes pre-closure leakage
        # in the model; human utterances use the first acoustic onset.
        high = signal.sosfilt(
            signal.butter(3, 1100, fs=rate, btype="highpass", output="sos"), samples
        )
        hop = round(0.001 * rate)
        env = np.sqrt(
            np.mean(high[: len(high) // hop * hop].reshape(-1, hop) ** 2, axis=1)
        )
        times = (np.arange(len(env)) + 0.5) * hop / rate
        if release_hint is None:
            lo, hi = max(0, self.start - 0.012), self.start + 0.042
        else:
            lo, hi = release_hint - 0.024, release_hint + 0.016
        window = np.flatnonzero((times >= lo) & (times <= hi))
        if release_hint is None:
            # Use the first high-frequency attack. The strongest peak may already be a vowel harmonic.
            significant = window[env[window] >= max(2e-5, 0.15 * np.max(env[window]))]
            k = significant[0] if len(significant) else window[np.argmax(env[window])]
        else:
            k = window[np.argmax(env[window])]
        self.burst = float(times[k])
        # A resonant burst can ring at high frequency for a few frames. Require a stable
        # stretch leading into the vowel. Apply the same criterion to every recording and render.
        core = self.hz[(self.hz > 0) & (self.db > -18)]
        typical = np.median(core if len(core) else self.hz[self.hz > 0])
        possible = runs(
            (self.t >= self.burst - 0.002)
            & (self.hz > typical * 0.56)
            & (self.hz < typical * 1.8)
        )
        self.onset = next((float(self.t[a]) for a, b in possible if b - a >= 6), None)
        if self.onset is None:
            raise ValueError("Cannot locate sustained voicing after the release")
        self.vot = max(0, self.onset - self.burst)

    def summary(self, word):
        return {
            "duration": round(1000 * (self.end - self.start)),
            "pitch": round(np.median(self.hz[self.hz > 0]), 1),
            "lag": round(self.vot * 1000) if word != WORDS[-1] else None,
            "f0": [
                [round(float(t - self.start), 3), round(float(f), 1) if f else None]
                for t, f in zip(self.t[::2], self.hz[::2])
                if self.start <= t <= self.end
            ],
        }


def alignment(a, b):
    """Monotonic DTW on level, periodicity and broad spectral bands, excluding padding."""
    ia = np.flatnonzero((a.t >= a.start) & (a.t <= a.end))
    ib = np.flatnonzero((b.t >= b.start) & (b.t <= b.end))
    shape = np.mean(abs(a.spectrum[ia, None, :] - b.spectrum[None, ib, :]), axis=2)
    cost = (
        shape / 13
        + np.abs(a.db[ia, None] - b.db[None, ib]) / 12
        + ((a.hz[ia, None] > 0) != (b.hz[None, ib] > 0))
    )
    n, m = cost.shape
    total = np.full((n + 1, m + 1), np.inf)
    total[0, 0] = 0
    trace = np.zeros((n, m), np.uint8)
    for i in range(n):
        for j in range(m):
            choices = (total[i, j], total[i, j + 1] + 0.25, total[i + 1, j] + 0.25)
            step = min(range(3), key=choices.__getitem__)
            trace[i, j] = step
            total[i + 1, j + 1] = cost[i, j] + choices[step]
    i, j = n - 1, m - 1
    path = []
    while i >= 0 and j >= 0:
        path.append((i, j))
        step = trace[i, j]
        i -= step != 2
        j -= step != 1
    ai, bi = np.array(path[::-1]).T
    voiced = (a.hz[ia[ai]] > 0) & (b.hz[ib[bi]] > 0)
    spec = np.mean(shape[ai[voiced], bi[voiced]]) if voiced.any() else 46.0
    return a.t[ia[ai]], b.t[ib[bi]], float(spec)


def make_fit(a, b, segments, profile, word):
    at, bt, _ = alignment(a, b)
    single = word != WORDS[-1]
    origin = a.burst if single else a.start
    target = b.burst if single else b.start
    offset = origin - target
    knots = [[0.0, 0.0], [origin, origin]]
    if single and a.onset > origin + 0.008 and b.onset > target + 0.006:
        knots.append([a.onset, b.onset + offset])
    # Word-final lateral /l/ and every sentence phone are driven by the aligned acoustics.
    for s in segments:
        for t in [(s["start"] + s["end"]) / 2, s["end"]]:
            dest = (
                float(np.median(bt[np.abs(at - t) <= 0.012]) + offset)
                if np.min(abs(at - t)) <= 0.012
                else None
            )
            if dest is not None and t < a.end - 0.020 and dest < b.end + offset - 0.014:
                if t - knots[-1][0] > 0.015 and dest - knots[-1][1] > 0.009:
                    knots.append([t, dest])
    if a.end - knots[-1][0] > 0.005 and b.end + offset - knots[-1][1] > 0.004:
        knots.append([a.end, b.end + offset])
    # A short lead offsets the model's existing pitch smoothing. Only periodic frames supply targets.
    pitches = []
    for i in range(0, len(b.t), 4):
        local = b.hz[max(0, i - 2) : i + 3]
        good = local[local > 0]
        if len(good) >= 3 and b.start <= b.t[i] <= b.end:
            pitches.append([max(0, b.t[i] + offset - 0.020), float(np.median(good))])
    return dict(profile, time=knots, pitch=pitches, preclose=single)


def write_json(path, data):
    path.write_text(
        json.dumps(data, ensure_ascii=False, allow_nan=False, separators=(",", ":")),
        encoding="utf8",
    )


def render(root, batch):
    jobs = root / "jobs.json"
    write_json(jobs, batch)
    subprocess.run(
        [
            *shlex.split(os.environ.get("CHIMERA_BUN", "bun")),
            "tools/korean/reference-render.ts",
            str(jobs),
            str(root),
        ],
        check=True,
    )


def read_render(root, name):
    info = json.loads((root / (name + ".json")).read_text())
    samples = np.fromfile(root / (name + ".f32"), "<f4").astype(float)
    return Analysis(samples, info["rate"], info["segments"][0]["end"]), info["segments"]


def wav_bytes(a, original):
    out = io.BytesIO()
    scale = 32768 if original else 32767
    wavfile.write(
        out, a.rate, np.clip(np.rint(a.y * scale), -32768, 32767).astype("<i2")
    )
    return out.getvalue()


def fitting_error(a, b, word):
    at, bt, spec = alignment(a, b)
    if word != WORDS[-1]:
        dur = abs((a.end - a.burst) - (b.end - b.burst))
    else:
        dur = abs((a.end - a.start) - (b.end - b.start))
    ah = a.hz[np.rint(at / HOP).astype(int)]
    bh = b.hz[np.rint(bt / HOP).astype(int)]
    voiced = (ah > 0) & (bh > 0)
    pitch = (
        float(np.median(12 * np.abs(np.log2(ah[voiced] / bh[voiced]))))
        if voiced.any()
        else 12.0
    )
    return {
        "spectrumDb": round(spec, 2),
        "spanMs": round(1000 * dur),
        "pitchSt": round(pitch, 2),
        "lagMs": round(1000 * abs(a.vot - b.vot)) if word != WORDS[-1] else None,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    for v in PRESETS:
        ap.add_argument("--" + v, type=Path)
    ap.add_argument("--work", required=True, type=Path)
    ap.add_argument("--pack", required=True, type=Path)
    args = ap.parse_args()
    root = args.work
    root.mkdir(parents=True, exist_ok=True)
    voices = [v for v in PRESETS if getattr(args, v)]
    if not voices:
        ap.error("Supply at least one speaker recording.")
    refs, spans = {}, {}
    for v in voices:
        for i, (samples, rate, span) in enumerate(split_recording(getattr(args, v))):
            refs[v, i] = Analysis(samples, rate)
            spans[v, i] = span

    def job(v, i, name, fit=None):
        return {
            "voice": v,
            "text": WORDS[i],
            "id": v + "-" + str(i) + "-" + name,
            "fit": fit,
        }

    render(root, [job(v, i, "base") for v, i in refs])
    before = {k: read_render(root, job(*k, "base")["id"]) for k in refs}

    # Fit ONE source and tract mix per recording, using the open syllable and the sentence.
    # The other five words have no vote in the choice of brightness or body.
    profiles = {}
    search = []
    trial_ids = [0, 6]
    for v in voices:
        female, child, bright = PRESETS[v]
        mixes = [(female, child)]
        for f, c, _ in PRESETS.values():
            blend = (0.65 * female + 0.35 * f, 0.65 * child + 0.35 * c)
            if blend not in mixes:
                mixes.append(blend)
        f0 = float(
            np.median(
                np.concatenate([refs[v, i].hz[refs[v, i].hz > 0] for i in trial_ids])
            )
        )
        for j, (f, c) in enumerate(mixes):
            for k, br in enumerate([bright, 0.08, 0.54]):
                label = f"profile-{j}-{k}"
                profile = {
                    "f0": round(f0, 2),
                    "brightness": br,
                    "body": {"female": f, "child": c},
                }
                profiles[v, label] = profile
                for i in trial_ids:
                    a, segs = before[v, i]
                    search.append(
                        job(
                            v,
                            i,
                            label,
                            make_fit(a, refs[v, i], segs, profile, WORDS[i]),
                        )
                    )
    render(root, search)
    chosen = {}
    for v in voices:
        costs = {}
        for voice, label in profiles:
            if voice == v:
                costs[label] = np.mean(
                    [
                        alignment(
                            read_render(root, job(v, i, label)["id"])[0], refs[v, i]
                        )[2]
                        for i in trial_ids
                    ]
                )
        chosen[v] = profiles[v, min(costs, key=costs.get)]
        print(v, "profile", chosen[v], flush=True)

    fits = {
        key: make_fit(a, refs[key], segs, chosen[key[0]], WORDS[key[1]])
        for key, (a, segs) in before.items()
    }
    render(root, [job(*key, "fit", fit) for key, fit in fits.items()])
    # Correct residual abduction timing measured on the emitted audio, then compare both candidates.
    refined = []
    for key, fit in fits.items():
        v, i = key
        if i == 6:
            continue
        a, _ = read_render(root, job(*key, "fit")["id"])
        shift = float(np.clip(refs[key].vot - a.vot, -0.055, 0.055))
        if abs(shift) > 0.004:
            refined.append(job(v, i, "lag", dict(fit, aspirationShift=shift)))
    render(root, refined)
    improved = {j["id"] for j in refined}

    def candidates(key):
        result = ["fit"]
        if job(*key, "lag")["id"] in improved:
            result.append("lag")
        return result

    def cost(err):
        return (
            err["spanMs"] / 35
            + (err["lagMs"] or 0) / 9
            + err["pitchSt"]
            + err["spectrumDb"] * 0.28
        )

    # The last periodic cycles need not coincide with the last lateral or breath gesture.
    # Adjust the emitted vowel and coda duration independently of the stop release.
    extra_jobs = []
    for key, fit in fits.items():
        v, i = key
        target = refs[key]
        best = min(
            candidates(key),
            key=lambda name: cost(
                fitting_error(
                    read_render(root, job(v, i, name)["id"])[0], target, WORDS[i]
                )
            ),
        )
        current, _ = read_render(root, job(v, i, best)["id"])
        ctrl = (
            fit
            if best == "fit"
            else next(j["fit"] for j in refined if j["id"] == job(v, i, best)["id"])
        )
        anchor = fit["time"][1][1]
        active_start = current.burst if i < 6 else current.start
        target_start = target.burst if i < 6 else target.start
        delta = (target.end - target_start) - (current.end - active_start)
        pivot = anchor + (target.vot + 0.015 if i < 6 else 0.0)
        window = max(0.10, current.end - active_start - (pivot - anchor))
        ratio = float(np.clip(1 + delta / window, 0.65, 1.65))
        warp = [
            [x, y if y <= pivot else pivot + (y - pivot) * ratio]
            for x, y in ctrl["time"]
        ]
        extras = [0.0]
        if i < 6:
            lag = target.vot - current.vot
            extras.append(float(np.clip(lag, -0.06, 0.08)))
            if abs(lag) > 0.014:
                extras.append(float(np.clip(1.6 * lag, -0.08, 0.10)))
        for n, d in enumerate(extras):
            settings = dict(
                ctrl, time=warp, aspirationShift=ctrl.get("aspirationShift", 0.0) + d
            )
            extra_jobs.append(job(v, i, "timing-" + str(n), settings))
    render(root, extra_jobs)

    pack = {"words": WORDS, "voices": {}}
    summary = {}
    settings = {job(*key, "fit")["id"]: fit for key, fit in fits.items()}
    settings.update({j["id"]: j["fit"] for j in refined + extra_jobs})
    chosen_controls = {}
    for v in voices:
        rows = []
        for i, w in enumerate(WORDS):
            key = v, i
            b = refs[key]
            a = before[key][0]
            ids = [job(*key, name)["id"] for name in candidates(key)]
            ids.extend(
                j["id"] for j in extra_jobs if j["voice"] == v and j["text"] == w
            )
            options = [(read_render(root, name)[0], name) for name in ids]
            output, used = min(
                options, key=lambda opt: cost(fitting_error(opt[0], b, w))
            )
            chosen_controls[used] = settings[used]
            err = fitting_error(output, b, w)
            row = {
                "text": w,
                "sourceSpan": [round(t, 3) for t in spans[key]],
                "takes": {},
                "beforeError": fitting_error(a, b, w),
                "afterError": err,
                "candidate": used,
            }
            for label, take in [("original", b), ("before", a), ("after", output)]:
                audio = wav_bytes(take, label == "original")
                (root / (v + "-" + str(i) + "-" + label + ".wav")).write_bytes(audio)
                metrics = take.summary(w)
                if i != 6:
                    metrics["rimeMs"] = round(1000 * (take.end - take.burst))
                row["takes"][label] = {
                    **metrics,
                    "wav": base64.b64encode(audio).decode("ascii"),
                }
            rows.append(row)
        pack["voices"][v] = {"profile": chosen[v], "rows": rows}
        summary[v] = {
            "profile": chosen[v],
            "rows": [
                {
                    **r,
                    "takes": {
                        k: {n: q for n, q in val.items() if n not in ("wav", "f0")}
                        for k, val in r["takes"].items()
                    },
                }
                for r in rows
            ],
        }
    args.pack.parent.mkdir(parents=True, exist_ok=True)
    write_json(args.pack, pack)
    write_json(root / "measurements.json", summary)
    write_json(root / "selected-controls.json", chosen_controls)


if __name__ == "__main__":
    main()
