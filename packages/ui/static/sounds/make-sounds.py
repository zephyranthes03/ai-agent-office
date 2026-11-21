#!/usr/bin/env python3
"""Original cartoon calls. Python standard library + an existing FFmpeg executable.

Run: python3 make-sounds.py [--out DIRECTORY]
No samples, AI audio service, network, or Python packages. Seeded synthesis.
"""
import argparse
import array
import hashlib
import json
import math
from pathlib import Path
import random
import shutil
import subprocess
import sys
import tempfile
import wave

RATE = 48000
TAU = math.tau
ATTACK = 0.008
RELEASE = 0.080
TARGET_LUFS = -20.0


def curve(points, t):
    """Smooth pitch/formant interpolation, without pitch steps."""
    for i in range(1, len(points)):
        if t <= points[i][0]:
            x0, y0 = points[i - 1]
            x1, y1 = points[i]
            u = max(0.0, min(1.0, (t - x0) / (x1 - x0)))
            u = u * u * (3 - 2 * u)
            return y0 + (y1 - y0) * u
    return points[-1][1]


def biquad(samples, frequency, q=0.7, mode="lowpass"):
    w = TAU * frequency / RATE
    c, s = math.cos(w), math.sin(w)
    alpha = s / (2 * q)
    a0, a1, a2 = 1 + alpha, -2 * c, 1 - alpha
    if mode == "bandpass":
        b0, b1, b2 = alpha, 0, -alpha
    else:
        b0, b1, b2 = (1 - c) / 2, 1 - c, (1 - c) / 2
    b0, b1, b2, a1, a2 = (v / a0 for v in (b0, b1, b2, a1, a2))
    x1 = x2 = y1 = y2 = 0.0
    result = []
    for x in samples:
        y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        result.append(y)
        x2, x1, y2, y1 = x1, x, y1, y
    return result


def envelope(t, duration, attack=ATTACK, release=RELEASE):
    rise = math.sin(math.pi * min(1.0, t / attack) / 2) ** 2
    fall = math.sin(math.pi * min(1.0, max(0.0, duration - t) / release) / 2) ** 2
    return rise * fall


def add(target, sound, start, gain=1.0):
    offset = round(start * RATE)
    if offset + len(sound) > len(target):
        raise ValueError("A call extends beyond its file")
    for i, sample in enumerate(sound):
        target[offset + i] += sample * gain


def voice(duration, pitches, vowels, *, breath=0.025, nasal=0.0,
          vibrato=0.008, flutter=0.0, seed=1):
    """Glottal harmonics shaped by moving broad formants plus filtered breath.

    Formants are tonal color, not phoneme samples or speech. Small deterministic
    pitch/energy variations keep the call from becoming a notification beep.
    """
    rng = random.Random(seed)
    count = round(duration * RATE)
    noise = biquad([rng.uniform(-1, 1) for _ in range(count)], 1350, 0.65, "bandpass")
    result, phase = [], 0.0
    for i in range(count):
        t = i / RATE
        u = t / duration
        f0 = curve(pitches, u) * (1 + vibrato * math.sin(TAU * 7.3 * t)
                                  + 0.003 * math.sin(TAU * 19.7 * t))
        phase += TAU * f0 / RATE
        f1 = curve(vowels[0], u)
        f2 = curve(vowels[1], u)
        sample = 0.0
        for h in range(1, 19):
            hz = h * f0
            if hz > 7000:
                break
            shape = (0.12 + 1.5 * math.exp(-0.5 * ((hz - f1) / 280) ** 2)
                     + 0.65 * math.exp(-0.5 * ((hz - f2) / 430) ** 2))
            sample += shape * math.sin(h * phase + 0.12 * math.sin(h)) / h ** 1.35
        sample += nasal * math.sin(phase / 2) + breath * noise[i]
        # A living little breath, not a sharp percussive transient.
        contour = (0.72 + 0.28 * math.sin(math.pi * u)) * (1 + flutter * math.sin(TAU * 13 * t))
        result.append(sample * contour * envelope(t, duration))
    return result


def sniff(duration, center, seed, strength=1.0):
    rng = random.Random(seed)
    raw = [rng.uniform(-1, 1) for _ in range(round(duration * RATE))]
    shaped = biquad(biquad(raw, center, 0.85, "bandpass"), 2800)
    return [x * strength * envelope(i / RATE, duration)
            * math.exp(-1.8 * i / len(shaped)) for i, x in enumerate(shaped)]


def whistle(duration, pitches, seed):
    rng = random.Random(seed)
    phase, result = 0.0, []
    for i in range(round(duration * RATE)):
        t = i / RATE
        f0 = curve(pitches, t / duration) * (1 + 0.006 * math.sin(TAU * 24 * t))
        phase += TAU * f0 / RATE
        x = math.sin(phase) + 0.045 * math.sin(2 * phase) + 0.004 * rng.uniform(-1, 1)
        result.append(x * envelope(t, duration))
    return result


def mallet(duration, frequency):
    return [envelope(i / RATE, duration)
            * sum(amp * math.sin(TAU * frequency * ratio * i / RATE)
                  * math.exp(-decay * i / RATE)
                  for ratio, amp, decay in [(1, 1, 5), (2, 0.22, 10), (3.01, 0.06, 16)])
            for i in range(round(duration * RATE))]


def synthesize():
    calls = {}
    def blank(seconds):
        return [0.0] * round(seconds * RATE)
    def vowel(a, b):
        return [[(0, a), (1, a)], [(0, b), (1, b)]]

    # Otter: two rounded, short contact chirps, low-high rather than bird whistles.
    x = blank(0.76)
    add(x, voice(0.27, [(0, 690), (.45, 930), (1, 760)], vowel(1100, 2350),
                 breath=.05, vibrato=.017, seed=10), .008, .9)
    add(x, voice(0.34, [(0, 780), (.35, 1050), (1, 800)], vowel(1200, 2500),
                 breath=.04, vibrato=.014, seed=11), .38)
    calls["otter"] = x

    # Cat: one long meow, changing from a closed nasal onset into an open vowel.
    x = blank(.98)
    add(x, voice(.93, [(0, 360), (.18, 490), (.42, 560), (.7, 440), (1, 300)],
                 [[(0, 480), (.3, 1150), (.65, 900), (1, 500)],
                  [(0, 1200), (.35, 1800), (.7, 1350), (1, 850)]],
                 breath=.045, nasal=.07, vibrato=.014, seed=20), .008)
    calls["cat"] = x

    # Bird: three clear, light, unequal whistles; no shrill broadband tweets.
    x = blank(.88)
    for start, duration, pitches, gain, seed in [
            (.008, .20, [(0, 1640), (.3, 2110), (1, 1850)], .80, 30),
            (.29, .19, [(0, 1970), (.4, 2350), (1, 2090)], .85, 31),
            (.55, .29, [(0, 2090), (.25, 2400), (.65, 1980), (1, 1650)], 1, 32)]:
        add(x, whistle(duration, pitches, seed), start, gain)
    calls["bird"] = x

    # Dog: two short, breathy chest woofs; no growl or aggressive bark attack.
    x = blank(.83)
    for start, duration, gain, seed in [(.008, .30, 1, 40), (.43, .35, .9, 41)]:
        add(x, voice(duration, [(0, 270), (.18, 235), (1, 155)],
                     [[(0, 720), (.4, 600), (1, 420)], [(0, 1550), (1, 900)]],
                     breath=.30, nasal=.08, vibrato=.01, seed=seed), start, gain)
        add(x, sniff(.14, 700, seed + 2, .20), start)
    calls["dog"] = x

    # Rabbit: sniff-sniff and one rounded, quiet "pup" (a deliberately imagined call).
    x = blank(.78)
    add(x, sniff(.16, 1050, 50, .7), .008)
    add(x, sniff(.15, 1300, 51, .6), .23)
    add(x, voice(.31, [(0, 470), (.38, 590), (1, 390)], vowel(650, 1100),
                 breath=.09, vibrato=.003, seed=52), .43, .4)
    calls["rabbit"] = x

    # Fox: one bright, inquisitive nasal yip with a soft breath at the end.
    x = blank(.72)
    add(x, voice(.60, [(0, 440), (.22, 650), (.62, 820), (.85, 920), (1, 720)],
                 [[(0, 1250), (1, 1650)], [(0, 2300), (1, 2600)]],
                 breath=.10, nasal=.13, vibrato=.018, flutter=.035, seed=60), .008)
    add(x, sniff(.16, 1500, 61, .12), .51)
    calls["fox"] = x

    # Panda: low warm cub-like murmuring/bleat, one gently wavering breath.
    x = blank(1.04)
    add(x, voice(.99, [(0, 190), (.28, 235), (.55, 205), (1, 145)],
                 [[(0, 480), (.5, 620), (1, 370)], [(0, 950), (1, 780)]],
                 breath=.065, nasal=.12, vibrato=.025, flutter=.10, seed=70), .008)
    calls["panda"] = x

    # Hedgehog: three dry little snuffles with tiny squeaky voiced centers.
    x = blank(.86)
    for index, (start, dur, pitch) in enumerate([(.008, .19, 900), (.27, .20, 790), (.56, .25, 680)]):
        add(x, sniff(dur, 1850 - index * 170, 80 + index, 1.5), start)
        add(x, voice(dur, [(0, pitch), (.25, pitch * 1.13), (1, pitch * .77)],
                     vowel(1800, 3000), breath=.1, vibrato=.03, seed=85 + index), start, .16)
    calls["hedgehog"] = x

    # Chime: an original warm wooden/glass pair a perfect fourth apart.
    x = blank(.98)
    add(x, mallet(.66, 392), .008, .85)
    add(x, mallet(.65, 523.25), .29, .80)
    calls["chime"] = x

    for name, sound in calls.items():
        # Remove DC then smooth high harmonics; apply a final 80 ms release.
        dc = sum(sound) / len(sound)
        sound = biquad([v - dc for v in sound], 4200, .6)
        calls[name] = [v * envelope(i / RATE, len(sound) / RATE)
                       for i, v in enumerate(sound)]
    return calls


DESCRIPTIONS = {
    "otter": ("수달", "🦦", "큐·큐", "Rounded two-part contact chirp, second longer and higher; harmonic voice with light breath.", "짧고 동그란 두 번의 큐·큐. 새의 맑은 휘파람과 다른 목소리 질감."),
    "cat": ("고양이", "🐈", "므냐웅", "One sustained falling meow; smoothly moving pitch and vowel formants with a nasal onset.", "입을 여닫는 듯한 모음 변화와 길게 내려오는 먀웅으로 구분."),
    "bird": ("새", "🐦", "휘·휘·휘리", "Three unequal smooth whistled chirps, almost pure tone; deliberately no piercing high overtones.", "세 번의 맑고 가벼운 지저귐. 짧은 음 사이의 간격으로 식별."),
    "dog": ("강아지", "🐕", "우프·우프", "Two low breathy woofs with rounded attacks, descending pitch and chest-like formants.", "세게 짖지 않는 낮은 두 번의 우프. 짧은 숨과 낮은 음역."),
    "rabbit": ("토끼", "🐇", "킁·킁·뿝", "Two airy filtered sniffs then one soft rounded voiced pup; an imagined cartoon call.", "조용한 동물이라 코 킁킁 뒤 작은 뿝을 상상해 제작. 실제 울음 재현 아님."),
    "fox": ("여우", "🦊", "이웁?", "One rising nasal questioning yip with an airy tail, no fox scream.", "여우의 비명 대신 살짝 올려 부르는 한 번의 이웁. 수달의 두 박자와 구분."),
    "panda": ("판다", "🐼", "므으", "One low warm cub-like murmur/bleat, gently wavering with broad low formants.", "낮고 포근한 아기 동물의 므으. 한 번 길게 울려 강아지와 구분."),
    "hedgehog": ("고슴도치", "🦔", "프·프·찍", "Three textured snuffles with descending tiny voiced centers; an imagined cartoon call.", "세 번의 마른 콧소리와 작은 찍. 토끼보다 촘촘하고 까슬한 질감."),
    "chime": ("일반 알림음", "🔔", "동·딩", "Original two-note warm mallet chime at 392 and 523.25 Hz with fast-decaying upper partials.", "동물과 다른 따뜻한 두 음. 기존 OS 알림 샘플을 사용하지 않음."),
}


def write_wav(path, samples, gain):
    data = array.array("h")
    for sample in samples:
        value = round(sample * gain * 32767)
        if abs(value) > 32767:
            raise ValueError("Clipping would occur; no silent limiter or clipping allowed")
        data.append(value)
    if sys.byteorder != "little":
        data.byteswap()
    with wave.open(str(path), "wb") as output:
        output.setparams((1, 2, RATE, 0, "NONE", "not compressed"))
        output.writeframes(data.tobytes())


def measure(ffmpeg, path):
    process = subprocess.run([ffmpeg, "-hide_banner", "-nostdin", "-i", str(path),
                              "-af", "loudnorm=I=-20:TP=-3:LRA=7:print_format=json",
                              "-f", "null", "-"], capture_output=True, text=True, check=True)
    report = process.stderr[process.stderr.rfind("{"):]
    # FFmpeg can append an output summary after the JSON object.
    measured, _ = json.JSONDecoder().raw_decode(report)
    return float(measured["input_i"]), float(measured["input_tp"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parent)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise SystemExit("FFmpeg must already be installed for LUFS verification; no packages will be installed.")
    ffmpeg_version = subprocess.run([ffmpeg, "-version"], capture_output=True, text=True, check=True).stdout.splitlines()[0]
    records = []
    with tempfile.TemporaryDirectory(prefix="notify-synthesis-") as temp:
        for name, sound in synthesize().items():
            raw = Path(temp) / f"{name}.wav"
            initial_gain = .4 / max(abs(v) for v in sound)
            write_wav(raw, sound, initial_gain)
            initial_lufs, _ = measure(ffmpeg, raw)
            gain = initial_gain * 10 ** ((TARGET_LUFS - initial_lufs) / 20)
            destination = args.out / f"{name}.wav"
            write_wav(destination, sound, gain)
            lufs, true_peak = measure(ffmpeg, destination)
            with wave.open(str(destination), "rb") as wav:
                pcm = array.array("h", wav.readframes(wav.getnframes()))
                if sys.byteorder != "little":
                    pcm.byteswap()
            peak = max(abs(v) for v in pcm) / 32768
            peak_db = 20 * math.log10(peak)
            onset = next(i for i, v in enumerate(pcm) if abs(v) >= 32) / RATE
            duration = len(pcm) / RATE
            if not (.35 <= duration <= 1.2 and abs(lufs + 20) <= 1 and peak_db <= -3
                    and true_peak <= -3 and onset <= .030 and pcm[0] == pcm[-1] == 0):
                raise ValueError(f"Audio contract failed: {name}, {duration=}, {lufs=}, {peak_db=}, {onset=}")
            ko, emoji, syllables, how, reason = DESCRIPTIONS[name]
            record = dict(file=destination.name, method="synth", how=how,
                          author="Original synthesis made for agent-office in this Codex session",
                          license="Original project asset; repository license applies. No third-party recordings or model-generated audio.",
                          duration_s=duration, integrated_lufs=lufs, peak_dbfs=round(peak_db, 3),
                          true_peak_dbtp=true_peak, sample_rate_hz=RATE, channels=1, bit_depth=16,
                          onset_above_minus60_dbfs_ms=round(onset * 1000, 3),
                          fade_in_ms=8, fade_out_ms=80, clipped_samples=sum(abs(v) >= 32767 for v in pcm),
                          sha256=hashlib.sha256(destination.read_bytes()).hexdigest(),
                          name_ko=ko, emoji=emoji, syllables=syllables, rationale_ko=reason,
                          measurement_tool=ffmpeg_version,
                          measurement="FFmpeg loudnorm input measurement of the final quantized WAV; gain only, no limiter",
                          perceptual_validation="Human listening/animal recognition and repeat-fatigue assessment pending")
            records.append(record)
            print(f"{name:9s} {duration:.2f}s  {lufs:6.2f} LUFS  {peak_db:6.2f} dBFS  {true_peak:6.2f} dBTP")
    (args.out / "sources.json").write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
