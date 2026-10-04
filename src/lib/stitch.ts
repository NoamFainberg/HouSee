import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { clipDurationSeconds } from "./env";
import { absoluteMediaPath, readTourRecord, writeMasterBytes } from "./store";

const execFileAsync = promisify(execFile);

/** Skip the duplicate opening of morph clips that match the previous clip's landing frame. */
const HANDOFF_SKIP_SEC = 0.45;
/** Crossfade between consecutive morph segments for smoother seams. */
const XFADE_SEC = 0.28;

const SCALE_FILTER =
  "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1";

async function assertFfmpeg() {
  try {
    await execFileAsync("ffmpeg", ["-version"]);
  } catch {
    throw new Error(
      "ffmpeg is not installed. Install it (e.g. `brew install ffmpeg`) and retry.",
    );
  }
}

async function probeDurationSeconds(file: string): Promise<number> {
  const probe = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  const parsed = Number(probe.stdout.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 4;
}

async function titlePng(title: string): Promise<Buffer> {
  const safe = title.replace(/[<>&]/g, "");
  const svg = `<svg width="1920" height="1080" xmlns="http://www.w3.org/2000/svg">
    <rect width="1920" height="1080" fill="#16110C"/>
    <text x="160" y="500" font-family="Georgia, 'Times New Roman', serif" font-size="72" fill="#F6EFE4">${safe}</text>
    <text x="160" y="580" font-family="Georgia, 'Times New Roman', serif" font-size="28" fill="#C4A574">House tour</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * Trim each Higgsfield morph so intermediate clips land on their end photo
 * (the next clip's opening frame) and later clips skip the duplicate hold.
 */
async function normalizeMorphClip(
  inputPath: string,
  outputPath: string,
  index: number,
  total: number,
  maxDuration: number,
): Promise<number> {
  const probed = await probeDurationSeconds(inputPath);
  let startSec = 0;
  if (index > 0) {
    startSec = Math.min(HANDOFF_SKIP_SEC, probed * 0.08);
  }

  let takeSec = Math.min(maxDuration, Math.max(0.5, probed - startSec));

  // Intermediate clips: align the segment ending on the closing (waypoint) frame.
  if (index < total - 1 && probed - startSec > takeSec) {
    startSec = Math.max(startSec, probed - takeSec);
    takeSec = Math.min(maxDuration, probed - startSec);
  }

  await execFileAsync("ffmpeg", [
    "-y",
    "-ss",
    String(startSec),
    "-i",
    inputPath,
    "-t",
    String(takeSec),
    "-vf",
    SCALE_FILTER,
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-r",
    "30",
    outputPath,
  ]);

  return probeDurationSeconds(outputPath);
}

async function xfadeClipChain(
  clipPaths: string[],
  durations: number[],
  outputPath: string,
): Promise<void> {
  if (clipPaths.length === 0) {
    throw new Error("No clips to crossfade");
  }
  if (clipPaths.length === 1) {
    await copyFile(clipPaths[0]!, outputPath);
    return;
  }

  const args = ["-y"];
  for (const path of clipPaths) {
    args.push("-i", path);
  }

  let filter = "";
  let offset = durations[0]! - XFADE_SEC;
  let lastLabel = "0:v";

  for (let index = 1; index < clipPaths.length; index += 1) {
    const outLabel = index === clipPaths.length - 1 ? "vout" : `v${index}`;
    filter += `[${lastLabel}][${index}:v]xfade=transition=fade:duration=${XFADE_SEC}:offset=${Math.max(0, offset).toFixed(3)}[${outLabel}];`;
    lastLabel = outLabel;
    if (index < clipPaths.length - 1) {
      offset += durations[index]! - XFADE_SEC;
    }
  }

  args.push(
    "-filter_complex",
    filter.slice(0, -1),
    "-map",
    "[vout]",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-r",
    "30",
    "-an",
    outputPath,
  );

  await execFileAsync("ffmpeg", args);
}

export async function stitchTour(tourId: string): Promise<string> {
  await assertFfmpeg();
  const record = await readTourRecord(tourId);
  const clips = record.clips
    .filter((clip) => clip.status === "completed" && clip.video_path)
    .sort((a, b) => a.sort_order - b.sort_order);

  if (clips.length === 0) {
    throw new Error("No completed clips to stitch");
  }

  const work = await mkdtemp(join(tmpdir(), "housee-"));
  const maxClipDuration = clipDurationSeconds();
  try {
    const normalizedPaths: string[] = [];
    const normalizedDurations: number[] = [];

    for (const [index, clip] of clips.entries()) {
      const rawPath = join(work, `raw-${index}.mp4`);
      const normalizedPath = join(work, `clip-${index}.mp4`);
      await copyFile(absoluteMediaPath(tourId, clip.video_path!), rawPath);
      const duration = await normalizeMorphClip(
        rawPath,
        normalizedPath,
        index,
        clips.length,
        maxClipDuration,
      );
      normalizedPaths.push(normalizedPath);
      normalizedDurations.push(duration);
    }

    const morphBody = join(work, "morph-body.mp4");
    await xfadeClipChain(normalizedPaths, normalizedDurations, morphBody);

    const titlePath = join(work, "title.png");
    const titleVideo = join(work, "title.mp4");
    await writeFile(titlePath, await titlePng(record.tour.title || "House tour"));
    await execFileAsync("ffmpeg", [
      "-y",
      "-loop",
      "1",
      "-t",
      "1.8",
      "-i",
      titlePath,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-r",
      "30",
      titleVideo,
    ]);

    const concatList = join(work, "concat.txt");
    await writeFile(
      concatList,
      [titleVideo, morphBody]
        .map((path) => `file '${path.replace(/'/g, "'\\''")}'`)
        .join("\n"),
    );

    const body = join(work, "body.mp4");
    await execFileAsync("ffmpeg", [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatList,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-r",
      "30",
      "-an",
      body,
    ]);

    const probe = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      body,
    ]);
    const duration = Math.max(4, Number(probe.stdout.trim()) || 40);
    const ambient = join(work, "ambient.wav");
    await execFileAsync("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `anoisesrc=color=pink:sample_rate=44100:amplitude=0.02:duration=${duration}`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=196:sample_rate=44100:duration=${duration}`,
      "-filter_complex",
      "[0]lowpass=f=380[a];[1]volume=0.035[b];[a][b]amix=inputs=2:duration=longest,alimiter=limit=0.18,volume=0.5",
      ambient,
    ]);

    const master = join(work, "master.mp4");
    await execFileAsync("ffmpeg", [
      "-y",
      "-i",
      body,
      "-i",
      ambient,
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-shortest",
      master,
    ]);

    return writeMasterBytes(tourId, await readFile(master));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
