#!/usr/bin/env bash
# Re-host one Notion image into R2.
#
# Notion serves images from S3 with X-Amz-Expires=300, so a captured URL is dead
# within five minutes. This downloads immediately and pushes to the VAULT bucket
# under a content-addressed key, printing the stable /files/ path to stdout.
#
#   ./scripts/rehost_image.sh "<signed notion url>"  ->  /files/img/<sha>.png
set -euo pipefail

URL="$1"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

if ! curl -sfL --max-time 60 "$URL" -o "$TMP"; then
  echo "FAILED: could not fetch (likely expired)" >&2
  exit 1
fi

# Content-addressed: the same image imported twice occupies one object, and the
# key never changes, so /files/ responses can be cached immutably.
SHA="$(shasum -a 256 "$TMP" | cut -c1-32)"
CT="$(file --mime-type -b "$TMP")"
case "$CT" in
  image/png)  EXT=png ;;
  image/jpeg) EXT=jpg ;;
  image/gif)  EXT=gif ;;
  image/webp) EXT=webp ;;
  image/svg*) EXT=svg ;;
  *) echo "FAILED: not an image ($CT)" >&2; exit 1 ;;
esac

KEY="img/${SHA}.${EXT}"
npx wrangler r2 object put "et-al-vault/${KEY}" --file="$TMP" --content-type="$CT" --remote >/dev/null 2>&1
echo "/files/${KEY}"
