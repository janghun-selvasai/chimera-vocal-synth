"""Shareable figures from a render directory, geometry.ts output, and measurements.csv."""

import argparse
import csv
import json
from pathlib import Path

import matplotlib
import numpy as np

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from analyze import samples
from matplotlib import font_manager

INK = "#142c38"
TEAL = "#007c79"
RED = "#b45135"
BLUE = "#365fad"
GRAY = "#50636c"
LIGHT = "#e2ebe9"
PAPER = "#fafbf7"


def title(fig, headline, sub):
    fig.text(
        0.065,
        0.948,
        headline,
        ha="left",
        va="top",
        fontsize=27,
        weight="bold",
        color=INK,
    )
    fig.text(0.067, 0.864, sub, fontsize=12, color=GRAY)


def polish(ax):
    ax.set_facecolor(PAPER)
    ax.spines[["right", "top", "left"]].set_visible(False)
    ax.spines["bottom"].set_color("#adbcbc")
    ax.tick_params(colors=GRAY, labelsize=10, length=3)


def footer(fig, txt):
    fig.text(0.067, 0.047, txt, color=GRAY, fontsize=10)


def first(root, table, out):
    fig = plt.figure(figsize=(13.2, 7.6), facecolor=PAPER)
    title(
        fig,
        "불 · 풀 · 뿔   |   같은 파열, 다른 유성 개시",
        "세 단어의 입술 파열을 0 ms에 맞췄습니다. 주황선은 파열, 파란선은 성대 진동이 나타난 시점입니다.",
    )
    gs = fig.add_gridspec(
        3,
        3,
        left=0.075,
        right=0.973,
        bottom=0.21,
        top=0.725,
        hspace=0.15,
        wspace=0.23,
        height_ratios=[2, 1, 1.15],
    )
    for i, (key, word) in enumerate([("bul", "불"), ("pul", "풀"), ("ppul", "뿔")]):
        d = json.loads((root / f"{key}-full.json").read_text(encoding="utf8"))
        p = np.array(d["probes"])
        y, fs = samples(root / f"{key}-full.wav")
        m = next(r for r in table if r["word"] == word and r["condition"] == "full")
        burst, voice = map(float, (m["burstMs"], m["voiceMs"]))
        vot = voice - burst
        x = np.arange(len(y)) / fs * 1000 - burst
        sel = (x >= -18) & (x <= 165)
        axes = [fig.add_subplot(gs[j, i]) for j in range(3)]
        ax = axes[0]
        ax.set_title(
            f"{word}    {['평음', '격음', '경음'][i]}",
            loc="left",
            fontsize=18,
            color=INK,
            pad=12,
            weight="bold",
        )
        ax.plot(x[sel], y[sel], lw=0.58, color=TEAL)
        ax.set_ylim(-0.7, 0.7)
        ax.set_yticks([-0.5, 0, 0.5])
        axes[1].plot(p[:, 0] * 1000 - burst, p[:, 2], color=BLUE, lw=1.7)
        axes[1].set_ylim(-0.05, 1.1)
        axes[1].set_yticks([0, 1])
        axes[2].plot(
            p[:, 0] * 1000 - burst,
            np.where(p[:, 2] >= 0.2, p[:, 7], np.nan),
            color=TEAL,
            lw=2,
        )
        axes[2].set_ylim(65, 115)
        axes[2].set_yticks([70, 90, 110])
        if i == 0:
            for a, label in zip(axes, ["출력 진폭", "유성도", "모델 F0 (Hz)"]):
                a.set_ylabel(label, fontsize=10, color=GRAY)
        for j, a in enumerate(axes):
            polish(a)
            a.set_xlim(-18, 165)
            a.axvspan(0, vot, color="#f6e8cc", zorder=-3)
            a.axvline(0, color=RED, lw=1)
            a.axvline(vot, color=BLUE, lw=1)
            a.set_xticks([0, 50, 100, 150])
            a.tick_params(labelbottom=j == 2)
        axes[-1].set_xlabel("파열 기준 시간 (ms)", fontsize=10)
        fig.text(
            0.075 + i * 0.320,
            0.114,
            f"VOT  {vot:.1f} ms     ·     ㅜ 시작  {float(m['wavHz']):.1f} Hz",
            color=INK,
            fontsize=13,
            weight="bold",
        )
    footer(
        fig,
        "최종 합성 · male / 112 Hz / 48 kHz. 시작 F0 수치는 유성 개시 직후 40 ms WAV의 자기상관 추정값입니다.",
    )
    fig.savefig(out / "01-stop-contrast.png", dpi=170)
    plt.close(fig)


def second(root, geometry, out):
    d = json.loads((root / "meogeo-full.json").read_text(encoding="utf8"))
    p = np.array(d["probes"])
    spans = d["plan"]["segments"]
    frames = json.loads(geometry.read_text(encoding="utf8"))
    fig = plt.figure(figsize=(13.2, 8), facecolor=PAPER)
    title(
        fig,
        "먹어 → [머거]   |   ㄱ은 어디에서 나는가",
        "첫 음절의 받침 ㄱ이 다음 음절의 초성 [g]로 이어집니다. 혀등이 연구개 쪽으로 올라갔다가 둘째 ㅓ로 내려옵니다.",
    )
    gs = fig.add_gridspec(
        2,
        3,
        left=0.073,
        right=0.97,
        top=0.775,
        bottom=0.16,
        height_ratios=[1.55, 1],
        wspace=0.17,
        hspace=0.3,
    )
    times = [0.256, 0.368, 0.464]
    labels = ["첫 ㅓ", "ㄱ 폐쇄", "둘째 ㅓ"]
    for i, (t, label) in enumerate(zip(times, labels)):
        f = min(frames, key=lambda v: abs(v["t"] - t))
        a = fig.add_subplot(gs[0, i])
        for key, col, lw in [
            ("outer", GRAY, 2),
            ("jawBone", "#b18675", 1.5),
            ("upperLip", RED, 2),
            ("lowerLip", RED, 2),
            ("tongue", TEAL, 2.3),
        ]:
            x = [v["x"] for v in f[key]]
            y = [v["y"] for v in f[key]]
            if key == "tongue":
                a.fill(x, y, color="#baddd4", alpha=0.85)
            a.plot(x, y, color=col, lw=lw)
        a.plot(f["tongueCenter"]["x"], f["tongueCenter"]["y"], "o", ms=5, color=TEAL)
        a.set(xlim=(-3, 10), ylim=(1.4, 12.5), aspect="equal")
        a.axis("off")
        a.set_title(
            f"{label}   ·   {t * 1000:.0f} ms", fontsize=16, weight="bold", color=INK
        )
    a = fig.add_subplot(gs[1, :])
    polish(a)
    a.plot(p[:, 0] * 1000, p[:, 1], color=TEAL, lw=2.3)
    a.set(
        xlim=(105, 615),
        ylim=(-0.1, 2.9),
        xlabel="렌더 시작 기준 시간 (ms)",
        ylabel="최소 구강 단면적 (cm²)",
    )
    for s in spans:
        x0, x1 = s["t0"] * 1000, s["t1"] * 1000
        a.fill_between(
            [x0, x1],
            2.36,
            2.83,
            color="#c8e3dc" if s["ipa"] == "g" else LIGHT,
            edgecolor=PAPER,
        )
        a.text(
            (x0 + x1) / 2,
            2.58,
            s["ipa"],
            ha="center",
            va="center",
            fontsize=14,
            fontfamily="DejaVu Sans",
            color=INK,
        )
    for t in times:
        idx = round(t * 1000)
        a.vlines(idx, 0, 2.33, color="#95adaa", ls="--", lw=1)
        a.scatter(idx, p[idx, 1], s=40, color=TEAL, zorder=4)
    footer(
        fig,
        "녹색 윤곽과 점은 실제 조음 상태에서 복원한 혀와 혀몸 중심입니다. 그래프의 단면적은 1 ms, 단면 그림은 16 ms 간격 기록에서 가져왔습니다.",
    )
    fig.savefig(out / "02-liaison.png", dpi=170)
    plt.close(fig)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    for key in ["renders", "geometry", "csv", "output"]:
        ap.add_argument(key, type=Path)
    ap.add_argument("--font", help="Path to a Korean font", required=True)
    a = ap.parse_args()
    font_manager.fontManager.addfont(a.font)
    plt.rcParams.update(
        {
            "font.family": [
                font_manager.FontProperties(fname=a.font).get_name(),
                "DejaVu Sans",
            ],
            "axes.unicode_minus": False,
        }
    )
    with a.csv.open(encoding="utf-8-sig") as f:
        table = list(csv.DictReader(f))
    first(a.renders, table, a.output)
    second(a.renders, a.geometry, a.output)
