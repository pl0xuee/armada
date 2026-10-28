#!/usr/bin/env python3
"""Synthesize Armada's original attention sounds (CC0).

Pure Python stdlib. Writes 44.1 kHz / 16-bit / mono WAVs into
apps/desktop/src-tauri/sounds/:

  permission.wav  two-tone rising metallic ping  (~350 ms)  "attention, needs you"
  done.wav        soft warm major-chord shimmer  (~600 ms)  "finished"
  error.wav       low muted thud                 (~300 ms)  "something went wrong"

Every sound gets a short fade in/out and is normalized to a -3 dBFS peak.

Usage: python3 scripts/gen_sounds.py
"""

import math
import os
import random
import struct
import wave

RATE = 44_100
PEAK_DBFS = -3.0
OUT_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..",
    "apps",
    "desktop",
    "src-tauri",
    "sounds",
)

TAU = 2.0 * math.pi


def silence(seconds):
    return [0.0] * int(round(seconds * RATE))


def mix_into(dst, src, offset_s=0.0, gain=1.0):
    off = int(round(offset_s * RATE))
    for i, v in enumerate(src):
        j = off + i
        if j >= len(dst):
            break
        dst[j] += v * gain


def envelope(n, attack_s, tau_s):
    """Linear attack then exponential decay."""
    a = max(1, int(attack_s * RATE))
    out = []
    for i in range(n):
        t = i / RATE
        if i < a:
            out.append(i / a)
        else:
            out.append(math.exp(-(t - attack_s) / tau_s))
    return out


def metallic_ping(freq, seconds):
    """Struck-bar style tone: inharmonic partials, the high ones dying fastest."""
    n = int(seconds * RATE)
    # Free-free bar mode ratios (1 : 2.756 : 5.404 : 8.933) give the "metal" colour.
    partials = [(1.0, 1.00, 0.110), (2.756, 0.42, 0.060), (5.404, 0.20, 0.035), (8.933, 0.08, 0.020)]
    out = [0.0] * n
    for ratio, amp, tau in partials:
        f = freq * ratio
        if f >= RATE / 2:
            continue
        env = envelope(n, 0.0025, tau)
        phase = random.random() * TAU
        for i in range(n):
            out[i] += amp * env[i] * math.sin(TAU * f * i / RATE + phase)
    return out


def warm_note(freq, seconds, attack_s=0.018, tau_s=0.32):
    """Soft sine with a hint of 2nd/3rd harmonic and a detuned twin for shimmer."""
    n = int(seconds * RATE)
    env = envelope(n, attack_s, tau_s)
    detune = 1.2  # Hz, slow beating = shimmer
    out = []
    for i in range(n):
        t = i / RATE
        trem = 1.0 + 0.06 * math.sin(TAU * 5.5 * t)
        v = (
            0.55 * math.sin(TAU * freq * t)
            + 0.45 * math.sin(TAU * (freq + detune) * t + 0.7)
            + 0.12 * math.sin(TAU * 2 * freq * t)
            + 0.04 * math.sin(TAU * 3 * freq * t)
        )
        out.append(v * env[i] * trem)
    return out


def thud(seconds):
    """Pitch-dropping sine body plus a low-passed noise 'knock'."""
    n = int(seconds * RATE)
    out = [0.0] * n
    phase = 0.0
    lp = 0.0
    rng = random.Random(7)
    for i in range(n):
        t = i / RATE
        f = 62.0 + 88.0 * math.exp(-t / 0.045)  # 150 Hz -> 62 Hz
        phase += TAU * f / RATE
        body = math.sin(phase) * math.exp(-t / 0.085)
        sub = 0.35 * math.sin(TAU * 49.0 * t) * math.exp(-t / 0.11)
        # one-pole low-pass on white noise -> muted felt-mallet knock
        lp += 0.06 * (rng.uniform(-1, 1) - lp)
        knock = 1.6 * lp * math.exp(-t / 0.018)
        out[i] = body + sub + knock
    # Gentle low-pass over the whole thing to keep it "muted".
    y = 0.0
    for i in range(n):
        y += 0.35 * (out[i] - y)
        out[i] = y
    return out


def fade(samples, fade_in_s=0.003, fade_out_s=0.04):
    n = len(samples)
    fi = max(1, int(fade_in_s * RATE))
    fo = max(1, int(fade_out_s * RATE))
    for i in range(min(fi, n)):
        samples[i] *= i / fi
    for i in range(min(fo, n)):
        # raised-cosine tail
        samples[n - 1 - i] *= 0.5 - 0.5 * math.cos(math.pi * i / fo)
    return samples


def normalize(samples, peak_dbfs=PEAK_DBFS):
    peak = max(abs(v) for v in samples) or 1.0
    target = 10 ** (peak_dbfs / 20.0)
    g = target / peak
    return [v * g for v in samples]


def write_wav(name, samples):
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, name)
    frames = b"".join(
        struct.pack("<h", max(-32768, min(32767, int(round(v * 32767))))) for v in samples
    )
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(frames)
    print(f"wrote {os.path.relpath(path)}  ({len(samples) / RATE * 1000:.0f} ms)")


def make_permission():
    total = 0.35
    out = silence(total)
    mix_into(out, metallic_ping(880.0, total), 0.0, 0.85)  # A5
    mix_into(out, metallic_ping(1318.5, total - 0.105), 0.105, 1.0)  # E6, a fifth up
    return normalize(fade(out, 0.002, 0.05))


def make_done():
    total = 0.6
    out = silence(total)
    # C major add9 voicing, lightly strummed upward.
    chord = [(523.25, 0.000, 1.00), (659.25, 0.028, 0.85), (783.99, 0.056, 0.80), (1046.5, 0.084, 0.45), (1174.66, 0.112, 0.22)]
    for f, off, g in chord:
        mix_into(out, warm_note(f, total - off), off, g)
    return normalize(fade(out, 0.004, 0.12))


def make_error():
    total = 0.3
    out = silence(total)
    mix_into(out, thud(total), 0.0, 1.0)
    return normalize(fade(out, 0.002, 0.06))


def main():
    random.seed(1337)  # deterministic output
    write_wav("permission.wav", make_permission())
    write_wav("done.wav", make_done())
    write_wav("error.wav", make_error())


if __name__ == "__main__":
    main()
