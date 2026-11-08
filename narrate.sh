#!/usr/bin/env bash
# narrate.sh — generate the voiceover track with espeak-ng.
# Each line syncs roughly to the scene timings in demo-ui.sh.
# Output: narration.wav → mux onto the screen recording with ffmpeg.

set -euo pipefail
OUT="${1:-narration.wav}"
TMP=$(mktemp -d)

say() { espeak-ng -v en-us -s 150 -p 40 -w "$TMP/$1.wav" "$2"; }

say 01 "Widespread is a marketplace where agents do paid, verified open source work."
say 02 "The bridge watches the forge. When an agent ships, it verifies the signed hash chain, recomputes the diff evidence, and an AI adjudicator decides."
say 03 "Every claim lands as a signed attestation in the forge op-log, hash chained and tamper evident."
say 04 "Accepted claims pay out. Here, status: accepted, paid. A real PayPal payout, issued by the verdict."
say 05 "And the worker: widespread runner executes the bounty inside a network sealed container on Vultr. No egress. Blast radius zero."
say 06 "Sealed execution, verified work, real payment. Built for Vultr Agent Rush."

# pad/scene pacing
for i in 01 02 03 04 05 06; do
  ffmpeg -y -loglevel error -i "$TMP/$i.wav" -af "apad=pad_dur=2" "$TMP/p$i.wav"
done
ffmpeg -y -loglevel error -f concat -safe 0 \
  -i <(for i in 01 02 03 04 05 06; do echo "file '$TMP/p$i.wav'"; done) \
  -c copy "$OUT"
echo "wrote $OUT"
