#!/bin/bash
# Turn a REDline ProRes render into a RED proxy that Premiere shows like the R3D.
#   red-proxy-finish.sh <ffmpeg> <redline-render.mov> <final_Proxy.mov>
#
# Picture: Premiere squeezes a RED clip's proxy into legal range when it plays it in place
# of the R3D (measured 19 Oct 2026: proxy = 0.855 x R3D + 15.8, i.e. x219/255 +16, so the
# picture looked lifted and flat). The same file imported as a normal clip shows correctly,
# so the squeeze is Premiere's RED proxy handling, not the file. The video is re-encoded
# with the inverse (legal -> full) levels so that after Premiere's squeeze it matches the
# R3D (measured: 0.994 x R3D - 0.05). Values above 100 % IRE in the log render would clip.
#
# Audio: REDline (REDCINE-X 64.x, --format 201) writes the camera audio as one multichannel
# stream with the channels rotated by one: file ch1 = R3D ch4, ch2 = R3D ch1,
# ch3 = R3D ch2, ch4 = R3D ch3. Premiere reads a proxy's channels in file order, so with
# proxies on A1 played R3D ch4 and so on (Lee, 19 Oct 2026; measured against Premiere's
# own decode of the R3D). This writes one mono stream per channel in R3D order (Premiere
# shows the R3D as "4 Mono" too). A render without audio (slow-motion clips) has none.
#
# Timecode track and metadata are copied. On success the REDline render is removed; on
# failure it is kept and nothing is written under the final name (-n never overwrites).
set -u
ffmpeg="$1"; in="$2"; out="$3"
ffprobe="$(dirname "$ffmpeg")/ffprobe"
expand="format=yuv422p10le,lutyuv=y='clip((val-64)*1023/876,0,1023)':u='clip((val-512)*1023/896+512,0,1023)':v='clip((val-512)*1023/896+512,0,1023)'"
video=(-c:v prores_ks -profile:v 2 -vendor apl0)
info="$("$ffprobe" -v error -select_streams a:0 -show_entries stream=channels,channel_layout -of csv=p=0 "$in" | head -1)"
n="${info%%,*}"; layout="${info#*,}"
if [ -z "$n" ]; then
  "$ffmpeg" -v error -nostdin -n -i "$in" -filter_complex "[0:v:0]$expand[v]" -map "[v]" -map "0:d?" \
    "${video[@]}" -c:d copy -map_metadata 0 "$out" || exit 1
elif [ "$n" -lt 2 ]; then
  "$ffmpeg" -v error -nostdin -n -i "$in" -filter_complex "[0:v:0]$expand[v]" -map "[v]" -map 0:a:0 -map "0:d?" \
    "${video[@]}" -c:a pcm_s24le -c:d copy -map_metadata 0 "$out" || exit 1
else
  # Split by the stream's own layout (REDline tags 4 channels "quad", 2 "stereo"): a
  # different layout name makes ffmpeg remix the channels instead of just separating them.
  case "$layout" in ""|*unknown*|*" channels"*) echo "red-proxy-finish: no usable channel layout ($info)" >&2; exit 1;; esac
  graph="[0:v:0]$expand[v];[0:a:0]channelsplit=channel_layout=$layout"
  maps=""
  for ((i = 0; i < n; i++)); do graph="$graph[c$i]"; done
  # R3D ch k (1-based) sits in file ch k+1; the R3D's last channel sits in file ch 1.
  for ((k = 1; k < n; k++)); do maps="$maps -map [c$k]"; done
  maps="$maps -map [c0]"
  "$ffmpeg" -v error -nostdin -n -i "$in" -filter_complex "$graph" -map "[v]" $maps -map "0:d?" \
    "${video[@]}" -c:a pcm_s24le -c:d copy -map_metadata 0 "$out" || exit 1
fi
rm -f "$in"
