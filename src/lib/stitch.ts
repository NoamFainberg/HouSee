import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { ffmpegBinary } from "./ffmpeg";
import { readMediaBytes, readTourRecord, writeMasterBytes } from "./store";
import type { Clip } from "./types";

const execFileAsync = promisify(execFile);

/** Skip duplicate static opening on clips that continue from the previous landing frame. */
const HANDOFF_SKIP_SEC = 0.35;
/** Hold the closing waypoint frame before cutting to the next morph. */
const END_HOLD_SEC = 0.45;

const SCALE_FILTER =
  "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1";

async function runFfmpeg(args: string[]) {
  return execFileAsync(await ffmpegBinary(), args, { maxBuffer: 8 * 1024 * 1024 });
}

async function probeDurationSeconds(file: string): Promise<number> {
  let text = "";
  try {
    const probe = await runFfmpeg(["-hide_banner", "-i", file, "-f", "null", "-"]);
    text = `${probe.stdout}\n${probe.stderr}`;
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    text = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
  }
  const match = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return 4;
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 4;
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

function isMorphClip(clip: Clip): boolean {
  return clip.camera_move === "spatial_blend" && Boolean(clip.end_photo_id);
}

function shouldSkipMorphOpening(prev: Clip | undefined, current: Clip): boolean {
  return Boolean(
    prev &&
      isMorphClip(prev) &&
      isMorphClip(current) &&
      prev.end_photo_id === current.photo_id,
  );
}

function shouldHoldMorphEnd(current: Clip, next: Clip | undefined): boolean {
  return Boolean(
    isMorphClip(current) &&
      next &&
      isMorphClip(next) &&
      next.photo_id === current.end_photo_id,
  );
}

/** Ken Burns / static holds play at full authored duration. */
async function normalizeHoldClip(
  inputPath: string,
  outputPath: string,
): Promise<number> {
  await runFfmpeg([
    "-y",
    "-i",
    inputPath,
    "-vf",
    SCALE_FILTER,
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-r",
    "30",
    outputPath,
  ]);
  return probeDurationSeconds(outputPath);
}

/**
 * Prepare Higgsfield morphs for chained playback when adjacent morphs share a frame.
 * Holds before/after morphs are separate clips — no skip or tail unless the next clip
 * continues the same morph chain.
 */
async function normalizeMorphClip(
  inputPath: string,
  outputPath: string,
  prev: Clip | undefined,
  current: Clip,
  next: Clip | undefined,
): Promise<number> {
  const probed = await probeDurationSeconds(inputPath);
  const skipOpening = shouldSkipMorphOpening(prev, current);
  let startSec = 0;
  if (skipOpening) {
    startSec = Math.min(HANDOFF_SKIP_SEC, Math.max(0, probed - 1) * 0.07);
  }

  const holdTail = shouldHoldMorphEnd(current, next) ? END_HOLD_SEC : 0;
  const takeSec = Math.max(0.5, probed - startSec);
  const vf = holdTail
    ? `${SCALE_FILTER},tpad=stop_mode=clone:stop_duration=${holdTail}`
    : SCALE_FILTER;

  await runFfmpeg([
    "-y",
    "-ss",
    String(startSec),
    "-i",
    inputPath,
    "-t",
    String(takeSec),
    "-vf",
    vf,
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-r",
    "30",
    outputPath,
  ]);

  return probeDurationSeconds(outputPath);
}

async function concatClips(clipPaths: string[], outputPath: string): Promise<void> {
  if (clipPaths.length === 0) {
    throw new Error("No clips to concatenate");
  }
  if (clipPaths.length === 1) {
    await copyFile(clipPaths[0]!, outputPath);
    return;
  }

  const listPath = outputPath.replace(/\.mp4$/, "-list.txt");
  await writeFile(
    listPath,
    clipPaths.map((path) => `file '${path.replace(/'/g, "'\\''")}'`).join("\n"),
  );

  await runFfmpeg([
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-r",
    "30",
    "-an",
    outputPath,
  ]);
}

export async function stitchTour(tourId: string): Promise<string> {
  await ffmpegBinary();
  const record = await readTourRecord(tourId);
  const clips = record.clips
    .filter((clip) => clip.status === "completed" && clip.video_path)
    .sort((a, b) => a.sort_order - b.sort_order);

  if (clips.length === 0) {
    throw new Error("No completed clips to stitch");
  }

  const work = await mkdtemp(join(tmpdir(), "housee-"));
  try {
    const normalizedPaths: string[] = [];

    for (const [index, clip] of clips.entries()) {
      const rawPath = join(work, `raw-${index}.mp4`);
      const normalizedPath = join(work, `clip-${index}.mp4`);
      await writeFile(rawPath, await readMediaBytes(tourId, clip.video_path!));
      if (clip.camera_move === "photo_hold") {
        await normalizeHoldClip(rawPath, normalizedPath);
      } else {
        await normalizeMorphClip(
          rawPath,
          normalizedPath,
          clips[index - 1],
          clip,
          clips[index + 1],
        );
      }
      normalizedPaths.push(normalizedPath);
    }

    const morphBody = join(work, "morph-body.mp4");
    await concatClips(normalizedPaths, morphBody);

    const titlePath = join(work, "title.png");
    const titleVideo = join(work, "title.mp4");
    await writeFile(titlePath, await titlePng(record.tour.title || "House tour"));
    await runFfmpeg([
      "-y",
      "-loop",
      "1",
      "-t",
      "1.8",
      "-i",
      titlePath,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
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
    await runFfmpeg([
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatList,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-r",
      "30",
      "-an",
      body,
    ]);

    const duration = Math.max(4, await probeDurationSeconds(body));
    const ambient = join(work, "ambient.wav");
    await runFfmpeg([
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
    await runFfmpeg([
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
