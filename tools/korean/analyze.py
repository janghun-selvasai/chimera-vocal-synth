"""Measure the native trace and WAV; build the replay data. Requires numpy and scipy."""

import argparse
import base64
import csv
import gzip
import json
import wave
from pathlib import Path

import numpy as np
from render import WORDS, trials
from scipy.signal import butter, sosfilt


def b64(raw):
    return base64.b64encode(raw).decode("ascii")


def samples(path):
    with wave.open(str(path)) as f:
        assert f.getsampwidth() == 2 and f.getnchannels() == 1
        return np.frombuffer(f.readframes(f.getnframes()), "<i2").astype(
            float
        ) / 32768, f.getframerate()


def acoustic_pitch(y, fs, t, hint):
    # Normalized autocorrelation, 40 ms from voicing onset. Interpolate the peak.
    x = y[round(t * fs) : round((t + 0.040) * fs) : 4]
    x = x - x.mean()
    step = fs / 4
    lo, hi = int(step / (hint * 1.30)), int(step / (hint * 0.75))
    lags = np.arange(lo - 1, hi + 2)
    r = np.array(
        [
            np.dot(x[k:], x[:-k])
            / max(1e-12, np.linalg.norm(x[k:]) * np.linalg.norm(x[:-k]))
            for k in lags
        ]
    )
    i = int(np.argmax(r[1:-1])) + 1
    if r[i] < 0.55 or r[i] <= max(r[i - 1], r[i + 1]):
        return None
    shift = 0.5 * (r[i - 1] - r[i + 1]) / (r[i - 1] - 2 * r[i] + r[i + 1])
    return round(step / (lags[i] + shift), 2)


def measure(d, y, fs):
    p = np.asarray(d["probes"])
    segments = d["plan"]["segments"]
    stop = segments[0]
    # Oral reopening anchors the burst search locally. Pick the largest 1 ms
    # high-pass RMS in [opening-3, opening+8] ms, and timestamp its centre.
    near = (p[:, 0] > stop["t1"] - 0.025) & (p[:, 0] < stop["t1"] + 0.055)
    opens = np.where(near[1:] & (p[:-1, 1] <= 0.02) & (p[1:, 1] > 0.02))[0]
    if not len(opens):
        raise ValueError(f"No oral reopening in {d['text']}")
    opening = p[opens[-1] + 1, 0]
    hp = sosfilt(butter(3, 1000, fs=fs, btype="highpass", output="sos"), y)
    starts = np.arange(round((opening - 0.003) * fs), round((opening + 0.008) * fs))
    power = np.convolve(hp**2, np.ones(round(0.001 * fs)), mode="valid")
    burst = (starts[np.argmax(power[starts])] + 0.0005 * fs) / fs
    start = np.where((p[:, 0] >= burst) & (p[:, 2] >= 0.2))[0][0]
    assert np.min(p[start : start + 10, 2]) >= 0.2
    voice = p[start, 0]
    window = (p[:, 0] >= voice + 0.005) & (p[:, 0] < voice + 0.040)
    hz = acoustic_pitch(y, fs, voice, np.median(p[window, 7]))
    # H1-H2 of the OUTPUT, uncorrected for the vocal tract; joint sinusoid
    # fit on 32 ms centred early in the vowel, using the local period.
    h12 = None
    if hz:
        a = round((voice + 0.007) * fs)
        x = y[a : a + round(0.032 * fs)]
        phase = 2 * np.pi * hz * np.arange(len(x)) / fs
        basis = np.column_stack(
            [
                np.ones(len(x)),
                np.cos(phase),
                np.sin(phase),
                np.cos(2 * phase),
                np.sin(2 * phase),
            ]
        )
        weight = np.hanning(len(x))
        h = np.linalg.lstsq(weight[:, None] * basis, weight * x, rcond=None)[0]
        h12 = round(20 * np.log10(np.hypot(*h[1:3]) / np.hypot(*h[3:])), 2)
    return {
        "openMs": round(opening * 1000, 1),
        "burstMs": round(burst * 1000, 1),
        "voiceMs": round(voice * 1000, 1),
        "votMs": round((voice - burst) * 1000, 1),
        "wavHz": hz,
        "modelHz": round(float(np.median(p[window, 7])), 2),
        "oq": round(float(p[start + 10, 5]), 3),
        "sharp": round(float(p[start + 10, 6]), 3),
        "h1h2Db": h12,
    }


def main(directory, bundle, table):
    records = {}
    rows = []
    for key, text, conditions in trials():
        records[key] = {"text": text, "takes": {}}
        for c in conditions:
            stem = directory / f"{key}-{c}"
            d = json.loads(stem.with_suffix(".json").read_text(encoding="utf8"))
            path = stem.with_suffix(".wav")
            y, fs = samples(path)
            assert np.isfinite(y).all() and max(abs(y)) < 1
            p = np.asarray(d["probes"])
            metrics = measure(d, y, fs) if key in WORDS else {}
            if metrics:
                rows.append(dict(word=text, condition=c, **metrics))
            stride = 48
            blocks = np.pad(y, (0, -len(y) % stride)).reshape(-1, stride)
            env = np.stack([blocks.min(1), blocks.max(1)], axis=1)
            records[key]["takes"][c] = {
                "wav": b64(path.read_bytes()),
                "tele": b64(stem.with_suffix(".tele").read_bytes()),
                "length": len(y) / fs,
                "segments": d["plan"]["segments"],
                "metrics": metrics,
                "envelope": np.rint(32767 * env).astype(int).tolist(),
                "voiced": "".join("1" if v >= 0.2 else "0" for v in p[:, 2]),
                "glottal": [round(float(v), 4) for v in p[:, 4]],
                "rms": float(
                    np.sqrt(
                        np.mean(
                            y[
                                round(fs * d["plan"]["segments"][0]["t0"]) : round(
                                    fs * d["plan"]["end"]
                                )
                            ]
                            ** 2
                        )
                    )
                ),
                "pitch": [round(v[7], 1) if v[2] >= 0.2 else None for v in p[::2]],
                "ipa": " | ".join(
                    " ".join(s.get("displayIpa", s["ipa"]) for s in ph["segments"]) for ph in d["phrases"]
                ),
            }
    bundle.parent.mkdir(parents=True, exist_ok=True)
    bundle.write_bytes(
        gzip.compress(
            json.dumps(records, ensure_ascii=False, separators=(",", ":")).encode(),
            compresslevel=6,
            mtime=0,
        )
    )
    with table.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=rows[0].keys())
        w.writeheader()
        w.writerows(rows)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for name in ("directory", "bundle", "table"):
        parser.add_argument(name, type=Path)
    a = parser.parse_args()
    main(a.directory, a.bundle, a.table)
