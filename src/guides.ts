// Lesson-guide picker flag (off by default) and the config the page reads when it is on.
//
// DCH_GUIDE_PICKER=1       turn the picker and the lesson videos on. Unset or anything else: off, and the
//                          server and the page behave exactly as they did before the feature existed.
// DCH_GUIDE_VIDEO_BASE     where the lesson videos are hosted: a same-origin path (default /lesson-videos/)
//                          or an https:// URL (a CDN or object store). Files are named in public/guides.js.
// The videos are never part of this repository (see docs/lesson-videos.md).

export const DEFAULT_VIDEO_BASE = "/lesson-videos/";

export interface GuideConfig {
  videoBase: string;
}

/** A same-origin path or an https URL, always ending in "/". Anything else falls back to the default. */
export function cleanVideoBase(raw: string | undefined): string {
  const v = (raw ?? "").trim();
  if (!v) return DEFAULT_VIDEO_BASE;
  let ok = false;
  if (/^\/(?!\/)[A-Za-z0-9._~/-]*$/.test(v) && !v.includes("..")) ok = true;
  else if (/^https:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~/-]*)?$/.test(v)) {
    try { ok = new URL(v).protocol === "https:"; } catch { ok = false; }
  }
  if (!ok) return DEFAULT_VIDEO_BASE;
  return v.endsWith("/") ? v : `${v}/`;
}

/** The config when the flag is on, else null. Read per request so a restart is the only switch. */
export function guideConfig(env: NodeJS.ProcessEnv = process.env): GuideConfig | null {
  if (env.DCH_GUIDE_PICKER !== "1") return null;
  return { videoBase: cleanVideoBase(env.DCH_GUIDE_VIDEO_BASE) };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Add the config as a <meta> in the page head (flag on only; with the flag off the file is sent untouched). */
export function injectGuideConfig(html: string, cfg: GuideConfig): string {
  const tag = `<meta name="dch-guides" content="${esc(JSON.stringify(cfg))}">`;
  return html.includes("</head>") ? html.replace("</head>", `${tag}\n</head>`) : html;
}
