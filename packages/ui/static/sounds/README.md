# Notification sounds

The desktop app (packages/app/src/sound.ts) and the phone's viewer (packages/ui/src/alerts.ts) play these with a notification (`notifications.sound`):
`chime.wav`, and one cry per species named as the office names it — `otter.wav`, `cat.wav`,
`bird.wav`, `dog.wav`, `rabbit.wav`, `fox.wav`, `panda.wav`, `hedgehog.wav`. WAV, mono, 48 kHz,
16-bit, under about a second, all at about −20 LUFS. A missing cry falls back to the chime; a missing
chime to the system's notification sound.

All nine are synthesized in code, with no recordings, samples or generated audio. `sources.json`
records how each was made, its measurements and its hash. `python3 make-sounds.py` (Python's standard
library and an installed FFmpeg, used to measure loudness) writes them and `sources.json` again into
this folder, the same bytes on the machine they were made on; `--out <folder>` writes a copy elsewhere.
