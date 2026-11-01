#!/usr/bin/env python3
"""Synthesizes Kvistcode's built-in notification sounds (the `soft` and `glass` packs).

README
------
Regenerate:  python3 apps/desktop/src-tauri/sounds/generate.py [--check]
Needs only numpy and the standard library. Output is deterministic (fixed RNG seeds), and
the committed WAVs are what ships; `classic/` is NOT produced here (those are the original
files, produced by scripts/gen_sounds.py, and are kept byte-identical).

Writes soft/{done,permission,error}.wav and glass/{done,permission,error}.wav next to this
file: stereo, 44.1 kHz, 16-bit.  `--check` prints level metrics for what is on disk instead
of writing (peak, loudness, DC, edge RMS).

Design
------
Everything lives in D major pentatonic (D E F# A B) so any mix of the three events sounds
like one family:

              soft (mallet / marimba bars)        glass (bar + FM bell, long shimmer)
  done        A4 -> D5 (+ quiet D4): rising       F#5 -> A5 -> D6: rising D major
              fourth that resolves to the tonic   arpeggio that lands on the tonic
  permission  E5 -> B5: two taps, rising fifth,   F#5 -> B5: two taps, rising fourth,
              brighter/clearer, ends "hanging"    ends on the 6th, unresolved
  error       F#4 -> D4: felt-muted falling       A4 -> F#4: dulled glass falling
              major third, no buzz                minor third

Per note: additive partials with exponentially decaying amplitudes (higher partials die
faster, like real bars), a 5-10 ms raised-cosine attack, and a tiny band-passed noise burst
for the "strike".  The partial ratios give the timbre: tuned marimba bar (1, 4, 10), felt
(1, 2, 3, 5), untuned free bar (1, 2.756, 5.404, 8.933) plus a decaying-index FM bell for
glass.  A detuned twin of the fundamental, opposite in sign in the left/right channel,
gives a slow shimmer and a little stereo decorrelation, as do a +-0.5 cent detune between
channels, an independent noise tick per channel and a small pan per note; partial phases
are shared by both channels so the clips stay mono-compatible.  A gentle 2nd-order
low-pass tames fizz, a Freeverb-style stereo reverb (parallel damped combs + series
allpasses, different delay sets per channel) adds space, a 50 Hz high-pass removes any DC,
and the last 30 ms are a cosine fade to exactly zero.  Each clip is then scaled to a target
integrated loudness (ITU-R BS.1770 K-weighting, gated, measured in this file): permission
is 1.5 LU above the other two so it cuts through.  The script exits non-zero if a true peak
is above -2 dBFS or any sample clips.

Nobody has listened to these while writing them: the levels, spectra and timings are
verified by measurement (ffmpeg ebur128, spectrograms), taste is not.  If you dislike a
sound, edit the clip table at the bottom (pitches, ring times, reverb) and regenerate.
"""

import sys
import wave
from pathlib import Path

import numpy as np

FS = 44100
OUT = Path(__file__).resolve().parent
LN1000 = 6.907755  # amplitude e-folds for -60 dB (T60)
FADE_OUT = 0.030  # seconds, cosine to zero
TP_LIMIT_DB = -2.0


# ---------------------------------------------------------------- filters


def biquad(x, b, a):
    """Direct-form-II-transposed biquad (python loop; clips are short)."""
    b0, b1, b2 = b
    a1, a2 = a
    y = np.empty_like(x)
    z1 = z2 = 0.0
    for n, xn in enumerate(x.tolist()):
        yn = b0 * xn + z1
        z1 = b1 * xn - a1 * yn + z2
        z2 = b2 * xn - a2 * yn
        y[n] = yn
    return y


def rbj(kind, f0, q, fs=FS):
    w0 = 2 * np.pi * f0 / fs
    alpha = np.sin(w0) / (2 * q)
    cw = np.cos(w0)
    if kind == "lp":
        b = [(1 - cw) / 2, 1 - cw, (1 - cw) / 2]
    elif kind == "hp":
        b = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2]
    elif kind == "bp":  # constant 0 dB peak gain
        b = [alpha, 0.0, -alpha]
    else:
        raise ValueError(kind)
    a0 = 1 + alpha
    return [v / a0 for v in b], [-2 * cw / a0, (1 - alpha) / a0]


def lowpass(x, f0, q=0.7071):
    return biquad(x, *rbj("lp", f0, q))


def highpass(x, f0, q=0.7071):
    return biquad(x, *rbj("hp", f0, q))


def bandpass(x, f0, q=0.9):
    return biquad(x, *rbj("bp", f0, q))


# ---------------------------------------------------------------- reverb

COMBS = {
    "l": [1116, 1188, 1277, 1356, 1422, 1491],
    "r": [1139, 1217, 1301, 1381, 1451, 1523],
}
ALLPASS = {"l": [556, 441], "r": [579, 466]}


def reverb_channel(x, side, rt60, damp, predelay):
    """Freeverb-style mono-in/mono-out reverb; the L and R delay sets differ."""
    n = len(x)
    out = np.zeros(n)
    xs = np.concatenate([np.zeros(int(predelay * FS)), x])[:n].tolist()
    for d in COMBS[side]:
        g = 10 ** (-3 * d / (FS * rt60))
        buf = [0.0] * d
        lp = 0.0
        i = 0
        o = np.empty(n)
        for k in range(n):
            v = buf[i]
            lp = v * (1 - damp) + lp * damp
            buf[i] = xs[k] + lp * g
            o[k] = v
            i += 1
            if i == d:
                i = 0
        out += o
    out /= len(COMBS[side])
    for d in ALLPASS[side]:
        buf = [0.0] * d
        i = 0
        ys = out.tolist()
        res = np.empty(n)
        for k in range(n):
            v = buf[i]
            xin = ys[k]
            buf[i] = xin + v * 0.5
            res[k] = v - xin
            i += 1
            if i == d:
                i = 0
        out = res
    return out


# ---------------------------------------------------------------- loudness (BS.1770 / EBU R128)


def k_weight(x):
    f0, g, q = 1681.974450955533, 3.999843853973347, 0.7071752369554196
    k = np.tan(np.pi * f0 / FS)
    vh = 10 ** (g / 20)
    vb = vh**0.4996667741545416
    a0 = 1 + k / q + k * k
    b = [(vh + vb * k / q + k * k) / a0, 2 * (k * k - vh) / a0, (vh - vb * k / q + k * k) / a0]
    a = [2 * (k * k - 1) / a0, (1 - k / q + k * k) / a0]
    y = biquad(x, b, a)
    f0, q = 38.13547087602444, 0.5003270373238773
    k = np.tan(np.pi * f0 / FS)
    a0 = 1 + k / q + k * k
    return biquad(y, [1.0, -2.0, 1.0], [2 * (k * k - 1) / a0, (1 - k / q + k * k) / a0])


def integrated_lufs(stereo):
    """Gated integrated loudness of a (2, n) array."""
    z = np.stack([k_weight(stereo[0]), k_weight(stereo[1])])
    blk, hop = int(0.4 * FS), int(0.1 * FS)
    n = z.shape[1]
    if n < blk:
        z = np.pad(z, ((0, 0), (0, blk - n)))
        n = blk
    ms = np.array([np.sum(np.mean(z[:, s : s + blk] ** 2, axis=1)) for s in range(0, n - blk + 1, hop)])
    lk = -0.691 + 10 * np.log10(np.maximum(ms, 1e-20))
    keep = lk > -70
    if not keep.any():
        return -70.0
    rel = -0.691 + 10 * np.log10(np.mean(ms[keep])) - 10
    keep &= lk > rel
    return float(-0.691 + 10 * np.log10(np.mean(ms[keep])))


def true_peak_db(stereo, over=4):
    peak = 0.0
    for ch in stereo:
        n = len(ch)
        spec = np.fft.rfft(ch)
        up = np.fft.irfft(spec, n * over) * over
        peak = max(peak, float(np.max(np.abs(up))))
    return 20 * np.log10(max(peak, 1e-12))


# ---------------------------------------------------------------- voices

TIMBRES = {
    # tuned marimba bar: 1 : 4 : 10, upper modes die quickly
    "mallet": dict(ratios=[1, 4.0, 10.0], amps=[1, 0.30, 0.07], decay=[1, 0.20, 0.07], attack=0.007,
                   strike=(3200, 0.16, 0.005), fm=0.0),
    # the permission variant: clearer, a touch more upper-partial and strike
    "mallet_bright": dict(ratios=[1, 4.0, 10.0], amps=[1, 0.46, 0.14], decay=[1, 0.26, 0.09], attack=0.005,
                          strike=(4200, 0.26, 0.004), fm=0.0),
    # felt-muted wooden thud: mostly fundamental + octave, no sparkle
    "felt": dict(ratios=[1, 2.0, 3.0, 5.0], amps=[1, 0.55, 0.20, 0.05], decay=[1, 0.55, 0.30, 0.15], attack=0.010,
                 strike=(650, 0.30, 0.012), fm=0.0),
    # untuned free bar (glockenspiel/glass): 1 : 2.756 : 5.404 : 8.933, plus a soft FM bell
    "glass": dict(ratios=[1, 2.0, 2.756, 5.404, 8.933], amps=[1, 0.10, 0.26, 0.10, 0.035],
                  decay=[1, 0.5, 0.33, 0.17, 0.09], attack=0.008, strike=(5200, 0.10, 0.004), fm=0.22),
    "glass_bright": dict(ratios=[1, 2.0, 2.756, 5.404, 8.933], amps=[1, 0.12, 0.34, 0.14, 0.05],
                         decay=[1, 0.5, 0.33, 0.17, 0.09], attack=0.006, strike=(5600, 0.14, 0.004), fm=0.28),
    # dulled glass for the error cue: a tapped tumbler under a cloth
    "glass_muted": dict(ratios=[1, 2.0, 2.756], amps=[1, 0.38, 0.10], decay=[1, 0.45, 0.25], attack=0.010,
                        strike=(1500, 0.22, 0.008), fm=0.0),
}


def note(rng, total, t0, f, ring, timbre, vel=1.0, pan=0.0, shimmer=0.24):
    """One struck note -> (2, total) array, zero before t0."""
    p = TIMBRES[timbre]
    n = total
    t = np.arange(n - int(t0 * FS)) / FS
    out = np.zeros((2, n))
    start = int(t0 * FS)
    # one phase set per note, shared by both channels, so they stay correlated (mono-safe)
    phases = rng.uniform(0, 2 * np.pi, len(p["ratios"]))
    tw_phase = rng.uniform(0, 2 * np.pi)
    for ch, sign in ((0, -1), (1, 1)):
        y = np.zeros(len(t))
        det = 1 + sign * 0.0003  # +-0.5 cent between channels
        for r, a, d, ph in zip(p["ratios"], p["amps"], p["decay"], phases):
            fr = f * r * det
            if fr > 13000:
                continue
            y += a * np.exp(-LN1000 * t / (ring * d)) * np.sin(2 * np.pi * fr * t + ph)
        # shimmer: a detuned twin of the fundamental (beats ~2 Hz), opposite per channel
        y += shimmer * np.exp(-LN1000 * t / (ring * 0.9)) * np.sin(
            2 * np.pi * (f + sign * 1.9) * t + tw_phase)
        if p["fm"]:
            idx = 1.8 * np.exp(-t / 0.10)
            y += p["fm"] * np.exp(-LN1000 * t / (ring * 0.45)) * np.sin(
                2 * np.pi * f * t + idx * np.sin(2 * np.pi * f * 3.5 * t))
        att = p["attack"]
        na = int(att * FS)
        env = np.ones(len(t))
        env[:na] = 0.5 - 0.5 * np.cos(np.pi * np.arange(na) / na)
        y *= env
        # strike: a very short band-passed noise tick
        fc, level, tau = p["strike"]
        ns = int(0.05 * FS)
        tt = np.arange(ns) / FS
        tick = bandpass(rng.standard_normal(ns), min(fc, f * 5), 0.8)
        tick *= np.exp(-tt / tau) * (0.5 - 0.5 * np.cos(np.pi * np.minimum(tt / 0.0015, 1.0)))
        y[:ns] += level * tick
        ang = (pan + 1) * np.pi / 4
        out[ch, start:] = y * vel * (np.cos(ang) if ch == 0 else np.sin(ang))
    return out


def render(spec, seed):
    rng = np.random.default_rng(seed)
    total = int(spec["dur"] * FS)
    dry = np.zeros((2, total))
    for nt in spec["notes"]:
        dry += note(rng, total, nt["t"], nt["f"], nt["ring"], nt["timbre"], nt.get("vel", 1.0), nt.get("pan", 0.0))
    dry = np.stack([lowpass(dry[0], spec["lp"]), lowpass(dry[1], spec["lp"])])
    wet = np.stack([
        reverb_channel(dry[0], "l", spec["rt60"], spec["damp"], 0.012),
        reverb_channel(dry[1], "r", spec["rt60"], spec["damp"], 0.015),
    ])
    wet = np.stack([highpass(wet[0], 220), highpass(wet[1], 220)])
    # wet level relative to dry, by energy
    scale = np.sqrt(np.sum(dry**2) / max(np.sum(wet**2), 1e-20)) * 10 ** (spec["wet_db"] / 20)
    mix = dry + wet * scale
    mix = np.stack([highpass(mix[0], 50), highpass(mix[1], 50)])
    nf = int(FADE_OUT * FS)
    mix[:, -nf:] *= (0.5 + 0.5 * np.cos(np.pi * np.arange(nf) / nf))
    mix[:, -1] = 0.0
    lufs = integrated_lufs(mix)
    mix *= 10 ** ((spec["lufs"] - lufs) / 20)
    return mix


def write_wav(path, stereo):
    pcm = np.clip(np.round(stereo * 32767), -32768, 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(FS)
        w.writeframes(pcm.T.copy().tobytes())


def read_wav(path):
    with wave.open(str(path), "rb") as w:
        assert w.getsampwidth() == 2
        ch = w.getnchannels()
        data = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(float) / 32768
    return data.reshape(-1, ch).T


def metrics(stereo):
    if stereo.shape[0] == 1:
        stereo = np.vstack([stereo, stereo])
    five = int(0.005 * FS)
    rms = lambda a: float(np.sqrt(np.mean(a**2)))  # noqa: E731
    return dict(
        dur=stereo.shape[1] / FS,
        peak_db=20 * np.log10(np.max(np.abs(stereo))),
        tp_db=true_peak_db(stereo),
        lufs=integrated_lufs(stereo),
        dc=float(np.mean(stereo)),
        head_rms=rms(stereo[:, :five]),
        tail_rms=rms(stereo[:, -five:]),
        clipped=int(np.sum(np.abs(stereo) >= 0.9999)),
    )


# ---------------------------------------------------------------- the clips

D4, E4, FS4, A4, B4 = 293.66, 329.63, 369.99, 440.00, 493.88
D5, E5, FS5, A5, B5 = 587.33, 659.25, 739.99, 880.00, 987.77
D6 = 1174.66

LOUD, LOUD_PERMISSION = -21.5, -20.0  # integrated LUFS targets

CLIPS = {
    "soft/done": dict(
        dur=1.05, lp=5200, rt60=0.95, damp=0.35, wet_db=-9.0, lufs=LOUD, seed=11,
        notes=[
            dict(t=0.00, f=A4, ring=0.55, timbre="mallet", vel=0.80, pan=-0.10),
            dict(t=0.14, f=D5, ring=1.00, timbre="mallet", vel=1.00, pan=0.10),
            dict(t=0.14, f=D4, ring=0.90, timbre="mallet", vel=0.32, pan=0.00),
        ],
    ),
    "soft/permission": dict(
        dur=0.78, lp=6500, rt60=0.80, damp=0.30, wet_db=-10.0, lufs=LOUD_PERMISSION, seed=12,
        notes=[
            dict(t=0.00, f=E5, ring=0.42, timbre="mallet_bright", vel=0.85, pan=-0.15),
            dict(t=0.17, f=B5, ring=0.60, timbre="mallet_bright", vel=1.00, pan=0.15),
        ],
    ),
    "soft/error": dict(
        dur=0.66, lp=2300, rt60=0.45, damp=0.55, wet_db=-13.0, lufs=LOUD, seed=13,
        notes=[
            dict(t=0.00, f=FS4, ring=0.24, timbre="felt", vel=0.90, pan=0.05),
            dict(t=0.17, f=D4, ring=0.34, timbre="felt", vel=1.00, pan=-0.05),
        ],
    ),
    "glass/done": dict(
        dur=1.45, lp=8500, rt60=1.80, damp=0.22, wet_db=-6.5, lufs=LOUD, seed=21,
        notes=[
            dict(t=0.00, f=FS5, ring=0.60, timbre="glass", vel=0.70, pan=-0.18),
            dict(t=0.10, f=A5, ring=0.70, timbre="glass", vel=0.82, pan=0.00),
            dict(t=0.20, f=D6, ring=1.30, timbre="glass", vel=1.00, pan=0.18),
        ],
    ),
    "glass/permission": dict(
        dur=1.02, lp=8800, rt60=1.50, damp=0.22, wet_db=-7.5, lufs=LOUD_PERMISSION, seed=22,
        notes=[
            dict(t=0.00, f=FS5, ring=0.50, timbre="glass_bright", vel=0.85, pan=-0.18),
            dict(t=0.19, f=B5, ring=0.85, timbre="glass_bright", vel=1.00, pan=0.18),
        ],
    ),
    "glass/error": dict(
        dur=0.72, lp=2600, rt60=0.60, damp=0.50, wet_db=-10.0, lufs=LOUD, seed=23,
        notes=[
            dict(t=0.00, f=A4, ring=0.30, timbre="glass_muted", vel=0.90, pan=0.05),
            dict(t=0.19, f=FS4, ring=0.42, timbre="glass_muted", vel=1.00, pan=-0.05),
        ],
    ),
}


def main():
    check = "--check" in sys.argv
    print(f"{'clip':18} {'dur':>5} {'peak':>6} {'tp':>6} {'LUFS':>6} {'dc':>9} {'head':>8} {'tail':>8} clip")
    ok = True
    for name, spec in CLIPS.items():
        path = OUT / f"{name}.wav"
        if check:
            audio = read_wav(path)
        else:
            audio = render(spec, spec["seed"])
            path.parent.mkdir(exist_ok=True)
            write_wav(path, audio)
            audio = read_wav(path)  # measure what shipped (after 16-bit rounding)
        m = metrics(audio)
        ok &= m["tp_db"] <= TP_LIMIT_DB and m["clipped"] == 0
        print(f"{name:18} {m['dur']:5.2f} {m['peak_db']:6.1f} {m['tp_db']:6.1f} {m['lufs']:6.1f} "
              f"{m['dc']:9.2e} {m['head_rms']:8.1e} {m['tail_rms']:8.1e} {m['clipped']}")
    if not ok:
        sys.exit("true peak above -2 dBFS or clipping: lower the targets or add headroom")


if __name__ == "__main__":
    main()
