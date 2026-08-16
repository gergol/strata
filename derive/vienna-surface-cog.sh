#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output="${1:-$repo_root/data/derived/vienna-35_4-dom-2m.cog.tif}"
source_url="https://www.wien.gv.at/ma41datenviewer/downloads/geodaten/dom_tif/35_4_dom_tif.zip"
source_sha="26ac8f8f605758826ac13298b39e2d7c6799646a0df183bab9f1e189368d6c42"
output_sha="44a9748fc386791511c649a7170f6eb6786501bb37b4621306e9105e4d94f8dc"
work_dir="$(mktemp -d /tmp/strata-vienna-surface.XXXXXX)"
trap 'rm -rf -- "$work_dir"' EXIT

mkdir -p "$(dirname "$output")"
curl --fail --location --retry 3 --output "$work_dir/source.zip" "$source_url"
printf '%s  %s\n' "$source_sha" "$work_dir/source.zip" | sha256sum --check --status
unzip -q "$work_dir/source.zip" '35_4_dom.tif' -d "$work_dir"

uvx --python 3.12 --from rasterio==1.5.1 rio warp \
  "$work_dir/35_4_dom.tif" "$work_dir/dom-2m.tif" \
  --res 2 --resampling average --target-aligned-pixels --dst-nodata -9999 \
  --threads 4 --overwrite

uvx --python 3.12 --from rasterio==1.5.1 rio convert \
  "$work_dir/dom-2m.tif" "$output" \
  --driver COG --dtype float32 --co BLOCKSIZE=256 --co COMPRESS=ZSTD \
  --co LEVEL=9 --co OVERVIEWS=AUTO --overwrite

printf '%s  %s\n' "$output_sha" "$output" | sha256sum --check --status
uvx --python 3.12 --from rio-cogeo==7.0.2 rio cogeo validate "$output"
printf 'built %s\n' "$output"
