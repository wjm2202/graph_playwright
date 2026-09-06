// stitch — ONE linear video from several parallel per-persona recordings.
//
// A multi-actor test (submitter acts, then approver, then submitter again)
// records one screen per persona, all running in parallel wall-clock time.
// Playing them one after another is wrong (they overlap in time) and side by
// side is noisy. What a reviewer wants is a single cut that shows WHOEVER IS
// ACTING: the `video-timeline` attachment says which persona each step ran
// as and when, so we trim that persona's recording to that window and
// concatenate the pieces in journey order.
//
// The producer's contract (attachment `video-timeline`, JSON):
//   { schema: 'video-timeline/v1',
//     videos:   [{ id, persona, file, startedAt }],           // epoch ms
//     segments: [{ persona, startedAt, endedAt, title, status }] }
// All times are on ONE clock (the producer's Date.now()). `file` is the
// basename of one of the test's `video` attachments.
//
// planCut() is PURE (unit-tested with fake clocks); stitchVideos() runs
// ffmpeg (integration-tested with synthetic colour clips, so a wrong cut
// shows up as the wrong colour at a known second).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FONT = path.resolve(HERE, '..', 'assets', 'font.ttf');
const fesc = (p) => String(p).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");

/** True when the attachment parses as our timeline and has something to cut. */
export function isVideoTimeline(obj) {
  return !!obj && obj.schema === 'video-timeline/v1' && Array.isArray(obj.videos) && Array.isArray(obj.segments);
}

/**
 * Who is on screen, when, from which file. PURE.
 *
 * @param timeline  the producer's video-timeline
 * @param durations { [videoId]: ms } — real lengths (ffprobe), so a recording
 *                  that ended early is never asked for frames it doesn't have
 * @param opts      { leadMs = 0 } — show this much before the first step
 * @returns { clips: [{ videoId, persona, inMs, durMs, title }], totalMs, skipped: [] }
 *
 * Rules, in order:
 *  1. The cut runs from the first segment's start (minus lead) to the last
 *     segment's end. Time between segments belongs to the NEXT segment's
 *     persona — you watch the next actor being brought on (their login).
 *  2. An interval is served by the persona's recording that had STARTED by
 *     the interval start (latest such). Before that persona has any
 *     recording, the previous clip's source keeps playing; if there is no
 *     previous clip yet, the interval is dropped (reported in `skipped`).
 *  3. Never read past a recording's real end: the interval is clamped and
 *     the remainder falls through to rule 2's fallback.
 *  4. Adjacent clips from the same file that touch are merged.
 */
export function planCut(timeline, durations = {}, opts = {}) {
  const lead = Math.max(0, Number(opts.leadMs ?? 0));
  const videos = (timeline.videos ?? [])
    .map((v) => ({ ...v, endAt: v.startedAt + (Number(durations[v.id]) || 0) }))
    .sort((a, b) => a.startedAt - b.startedAt);
  const segs = (timeline.segments ?? [])
    .filter((s) => Number.isFinite(s.startedAt) && Number.isFinite(s.endedAt) && s.endedAt >= s.startedAt)
    .slice()
    .sort((a, b) => a.startedAt - b.startedAt);
  if (!videos.length || !segs.length) return { clips: [], totalMs: 0, skipped: segs.map((s) => s.title) };

  // 1. contiguous intervals: gap before a segment → that segment's persona
  const intervals = [];
  let cursor = Math.max(0, segs[0].startedAt - lead);
  for (const s of segs) {
    const start = Math.max(cursor, s.startedAt);
    if (s.startedAt > cursor) intervals.push({ persona: s.persona, from: cursor, to: s.startedAt, title: s.title, gap: true });
    if (s.endedAt > start) intervals.push({ persona: s.persona, from: start, to: s.endedAt, title: s.title, gap: false });
    cursor = Math.max(cursor, s.endedAt);
  }

  // 2/3. source per interval, with fallback + clamping
  const clips = [];
  const skipped = [];
  const latestStartedBy = (persona, t) => {
    let best = null;
    for (const v of videos) if (v.persona === persona && v.startedAt <= t && (!best || v.startedAt > best.startedAt)) best = v;
    return best;
  };
  const push = (video, from, to, title) => {
    if (to <= from) return;
    const last = clips[clips.length - 1];
    const inMs = from - video.startedAt;
    if (last && last.videoId === video.id && last.inMs + last.durMs === inMs) { last.durMs += to - from; return; }
    clips.push({ videoId: video.id, persona: video.persona, inMs, durMs: to - from, title });
  };
  const fallback = (from, to, title) => {
    const last = clips[clips.length - 1];
    if (!last) { skipped.push(title); return; }
    const src = videos.find((v) => v.id === last.videoId);
    const end = Math.min(to, src.endAt);
    push(src, from, end, title);
    if (end < to) skipped.push(title); // nothing left to show
  };
  for (const iv of intervals) {
    let t = iv.from;
    while (t < iv.to) {
      const v = latestStartedBy(iv.persona, t);
      if (!v) {
        // persona has no recording yet — until their first one starts, or the interval ends
        const next = videos.find((x) => x.persona === iv.persona && x.startedAt > t);
        const until = next ? Math.min(next.startedAt, iv.to) : iv.to;
        fallback(t, until, iv.title);
        t = until;
        continue;
      }
      const until = Math.min(iv.to, v.endAt);
      if (until <= t) {
        // that recording is over; is there a later one for this persona?
        const next = videos.find((x) => x.persona === iv.persona && x.startedAt > t);
        const stop = next ? Math.min(next.startedAt, iv.to) : iv.to;
        fallback(t, stop, iv.title);
        t = stop;
        continue;
      }
      push(v, t, until, iv.title);
      t = until;
    }
  }
  const totalMs = clips.reduce((n, c) => n + c.durMs, 0);
  return { clips, totalMs, skipped };
}

/** ffprobe → ms (0 when it fails, so the planner treats the file as empty). */
export function probeMs(file) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]).toString().trim();
    return Math.round(Number(out) * 1000) || 0;
  } catch { return 0; }
}

/** The ffmpeg argv for a plan. PURE (no exec) so the command is testable. */
export function ffmpegArgs(plan, files, out, { width = 1280, height = 720, fps = 25, label = true, font = FONT } = {}) {
  const args = ['-y'];
  const chains = [];
  plan.clips.forEach((c, i) => {
    args.push('-i', files[c.videoId]);
    const s = (c.inMs / 1000).toFixed(3);
    const e = ((c.inMs + c.durMs) / 1000).toFixed(3);
    const text = label && existsSync(font)
      ? `,drawtext=fontfile='${fesc(font)}':text='${fesc(`${c.persona} · ${c.title}`)}':fontcolor=white:fontsize=${Math.round(height / 30)}:x=12:y=12:box=1:boxcolor=black@0.55:boxborderw=8`
      : '';
    chains.push(
      `[${i}:v]trim=start=${s}:end=${e},setpts=PTS-STARTPTS,` +
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps}${text}[c${i}]`,
    );
  });
  const inputs = plan.clips.map((_, i) => `[c${i}]`).join('');
  chains.push(`${inputs}concat=n=${plan.clips.length}:v=1:a=0[v]`);
  args.push('-filter_complex', chains.join(';'), '-map', '[v]', '-an',
    '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '2M', out);
  return args;
}

/**
 * Cut and write `out`. `files` maps timeline video id → absolute path.
 * Returns the plan (with the real durations used) or null when nothing to cut.
 */
export function stitchVideos(timeline, files, out, opts = {}) {
  const durations = {};
  for (const v of timeline.videos ?? []) durations[v.id] = files[v.id] && existsSync(files[v.id]) ? probeMs(files[v.id]) : 0;
  const usable = { ...timeline, videos: (timeline.videos ?? []).filter((v) => durations[v.id] > 0) };
  const plan = planCut(usable, durations, opts);
  if (!plan.clips.length) return null;
  mkdirSync(path.dirname(out), { recursive: true });
  const args = ffmpegArgs(plan, files, out, opts);
  if (opts.dumpArgs) writeFileSync(opts.dumpArgs, JSON.stringify(args, null, 2));
  execFileSync('ffmpeg', ['-v', 'error', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
  return { ...plan, durations };
}
