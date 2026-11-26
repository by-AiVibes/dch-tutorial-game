# Lesson videos: hosting proposal

The guide picker (flag `DCH_GUIDE_PICKER=1`, off by default) plays a short lesson video before each
level's quiz. The videos are **not in this repository**: the 18 source files are about 1.0 GB
(1,025 MB), too big for git. The page asks for them at `DCH_GUIDE_VIDEO_BASE`
(default `/lesson-videos/`, a same-origin path; or an `https://` URL). File names are in
`public/guides.js` (`LESSON_VIDEOS`).

## Files

| Level id | Guide A | Guide B |
| --- | --- | --- |
| wallet (Level 0) | `level1-guide-a.mp4` | `level1-guide-b-v2.mp4` |
| issue | `issue-guide-a.mp4` | `issue-guide-b.mp4` |
| freeze | `freeze-guide-a.mp4` | `freeze-guide-b.mp4` |
| creds | `creds-guide-a.mp4` | `creds-guide-b.mp4` |
| domain | `domain-guide-a.mp4` | `domain-guide-b.mp4` |
| batch | `batch-guide-a.mp4` | `batch-guide-b.mp4` |
| vault | `vault-guide-a.mp4` | `vault-guide-b.mp4` |
| lend | `lend-guide-a.mp4` | `lend-guide-b.mp4` |
| confidential | `confidential-guide-a.mp4` | `confidential-guide-b.mp4` |

Source: 1440x1440 H.264, about 59 s each, 33 to 83 MB. If a video is missing or fails to load the page
shows "Video unavailable" and Continue; the quiz is never blocked.

## Measured: 720p H.264, CRF 28, faststart

```
ffmpeg -i in.mp4 -vf scale=-2:720 -c:v libx264 -crf 28 -preset medium -pix_fmt yuv420p \
       -c:a aac -b:a 64k -movflags +faststart out.mp4
```

| Sample | Source | Compressed | Ratio |
| --- | --- | --- | --- |
| `issue-guide-a.mp4` | 80.4 MB | 4.0 MB | 5.0% |
| `level1-guide-b-v2.mp4` | 34.4 MB | 3.4 MB | 9.9% |

Output was 720x720, about 470 kbit/s video plus 63 kbit/s audio for guide A. About 10 s of encoding per
video. A frame from the guide A sample looked clean (a talking head on a plain background compresses well).

Extrapolated to all 18 files by guide (guide A files 693 MB at 5.0%, guide B files 332 MB at 9.9%):

| | Source | Compressed (estimate) |
| --- | --- | --- |
| Guide A, 9 files | 693 MB | about 34 MB |
| Guide B, 9 files | 332 MB | about 33 MB |
| **All 18 files** | **1,025 MB** | **about 67 MB** (range 51 to 102 MB if every file lands at the lower or higher ratio) |

A player downloads one video at a time: about 3.5 to 4 MB each.

## Option (a): compress, serve from the game's own static host

- Encode once with the command above, copy the 18 files to a folder on the game host, and have the
  reverse proxy serve that folder at `/lesson-videos/` (the default base). The Node server does not serve
  them: it reads whole files without range support, which is wrong for video.
- Proxy needs: `Accept-Ranges` (any static file server does this), `Cache-Control: public, max-age=31536000, immutable`
  (rename a file when it changes), and `Content-Type: video/mp4`.
- CSP: stays `self`-only, since the videos are same-origin. Nothing to change.
- Cost: about 67 MB on disk. Traffic is about 4 MB per video watched, so 1,000 players watching all nine
  lessons is about 34 GB. That is the one number to watch on a small host.
- No third party, no new account, no new failure mode. The same host that serves the game serves the lessons.

## Option (b): a CDN or object store

- Upload the files (compressed or not) to a bucket behind a CDN and set `DCH_GUIDE_VIDEO_BASE=https://<cdn host>/lessons/`.
- CSP: `media-src` must allow the CDN host. The CDN needs range requests and `Content-Type: video/mp4`.
- Pros: the game host carries none of the video traffic, and the files are close to the player.
- Cons: a new account, a new bill, a second place to deploy, and another host in the page's CSP. Egress is
  charged per GB, so the same 34 GB per 1,000 players is a cost, not a number to watch.
- Still worth compressing first: with the originals, 1,000 players each watching nine lessons would pull
  roughly 330 to 690 GB (the originals average 37 MB for guide B and 77 MB for guide A).

## Recommendation

Do (a). Compress to 720p H.264 CRF 28 (about 67 MB for everything) and serve from the game's own static
host at `/lesson-videos/`. The lessons are small once compressed, there is nothing to sign up for or pay for,
and the CSP and the hosting stay as they are. Move to (b) by changing only `DCH_GUIDE_VIDEO_BASE` if video traffic
ever outgrows the host. The page code is the same either way.

Nothing in this change uploads or deploys anything. The measurements above were made by encoding two sample
files on the build box.
