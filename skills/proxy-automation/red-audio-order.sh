#!/bin/bash
# Re-wrap a REDline ProRes render so its camera audio is in the R3D's channel order.
#   red-audio-order.sh <ffmpeg> <redline-render.mov> <final_Proxy.mov>
#
# REDline (REDCINE-X 64.x, --format 201) writes the camera audio as one multichannel
# stream with the channels rotated by one: file ch1 = R3D ch4, ch2 = R3D ch1,
# ch3 = R3D ch2, ch4 = R3D ch3. Premiere reads a proxy's channels in file order, so with
# proxies on A1 played R3D ch4 and so on (Lee, 19 Oct 2026; measured against Premiere's
# own decode of the R3D). This writes one mono stream per channel in R3D order (Premiere
# shows the R3D as "4 Mono" too). Video, timecode track and colour tags are copied as is.
# A render without audio (slow-motion clips) is copied unchanged.
# On success the REDline render is removed; on failure it is kept and nothing is written
# under the final name (ffmpeg -n never overwrites an existing proxy).
set -u
ffmpeg="$1"; in="$2"; out="$3"
ffprobe="$(dirname "$ffmpeg")/ffprobe"
info="$("$ffprobe" -v error -select_streams a:0 -show_entries stream=channels,channel_layout -of csv=p=0 "$in" | head -1)"
n="${info%%,*}"; layout="${info#*,}"
if [ -z "$n" ] || [ "$n" -lt 2 ]; then
  "$ffmpeg" -v error -nostdin -n -i "$in" -map 0 -c copy -map_metadata 0 "$out" || exit 1
else
  # Split by the stream's own layout (REDline tags 4 channels "quad"): a different layout
  # name makes ffmpeg remix the channels instead of just separating them.
  case "$layout" in ""|*unknown*|*" channels"*) echo "red-audio-order: no usable channel layout ($info)" >&2; exit 1;; esac
  split="[0:a:0]channelsplit=channel_layout=$layout"
  maps=""
  for ((i = 0; i < n; i++)); do split="$split[c$i]"; done
  # R3D ch k (1-based) sits in file ch k+1; the R3D's last channel sits in file ch 1.
  for ((k = 1; k < n; k++)); do maps="$maps -map [c$k]"; done
  maps="$maps -map [c0]"
  "$ffmpeg" -v error -nostdin -n -i "$in" -filter_complex "$split" -map 0:v:0 $maps -map "0:d?" \
    -c:v copy -c:d copy -c:a pcm_s24le -map_metadata 0 "$out" || exit 1
fi
rm -f "$in"
