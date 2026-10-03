import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { clipLabel, ROOM_LABELS } from "./rooms";
import { clipDurationSeconds } from "./env";
import { absoluteMediaPath, readTourRecord, writeMasterBytes } from "./store";
import type { RoomType } from "./types";

const execFileAsync = promisify(execFile);

async function assertFfmpeg() {
  try {
    await execFileAsync("ffmpeg", ["-version"]);
  } catch {
    throw new Error(
      "ffmpeg is not installed. Install it (e.g. `brew install ffmpeg`) and retry.",
    );
  }
}

async function overlayPng(label: string): Promise<Buffer> {
  const safe = label.replace(/[<>&]/g, "");
  const svg = `<svg width="1920" height="1080" xmlns="http://www.w3.org/2000/svg">
    <rect x="72" y="948" rx="12" ry="12" width="${Math.min(720, 80 + safe.length * 18)}" height="64" fill="rgba(18,14,10,0.55)"/>
    <text x="96" y="992" font-family="Georgia, 'Times New Roman', serif" font-size="32" fill="#F6EFE4">${safe}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
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

async function probeDuration(path: string): Promise<number> {
  const probe = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    path,
  ]);
  const parsed = Number(probe.stdout.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : clipDurationSeconds();
}

function xfadeFilter(durations: number[], fade: number) {
  const clipCount = durations.length;
  const scaled: string[] = [];
  for (let i = 0; i < clipCount; i += 1) {
    scaled.push(
      `[${i}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p,setpts=PTS-STARTPTS[v${i}]`,
    );
  }
  if (clipCount === 1) {
    return `${scaled.join(";")};[v0]copy[vout]`;
  }
  const fades: string[] = [];
  let last = "v0";
  let offset = Math.max(0, durations[0]! - fade);
  for (let i = 1; i < clipCount; i += 1) {
    const next = i === clipCount - 1 ? "vout" : `x${i}`;
    fades.push(
      `[${last}][v${i}]xfade=transition=fade:duration=${fade}:offset=${offset.toFixed(2)}[${next}]`,
    );
    last = next;
    offset += Math.max(0, durations[i]! - fade);
  }
  return `${scaled.join(";")};${fades.join(";")}`;
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
  const clipDuration = clipDurationSeconds();
  try {
    const clipPaths: string[] = [];
    for (const [index, clip] of clips.entries()) {
      const rawPath = join(work, `raw-${index}.mp4`);
      const labeledPath = join(work, `clip-${index}.mp4`);
      await copyFile(absoluteMediaPath(tourId, clip.video_path!), rawPath);
      const endPhoto = clip.end_photo_id
        ? record.photos.find((photo) => photo.id === clip.end_photo_id)
        : undefined;
      const overlayPath = join(work, `overlay-${index}.png`);
      await writeFile(
        overlayPath,
        await overlayPng(
          endPhoto
            ? clipLabel(
                (clip.room_type as RoomType) ?? "other",
                endPhoto.room_type,
              )
            : ROOM_LABELS[(clip.room_type as RoomType) ?? "other"] ?? "Room",
        ),
      );
      await execFileAsync("ffmpeg", [
        "-y",
        "-i",
        rawPath,
        "-t",
        String(clipDuration),
        "-i",
        overlayPath,
        "-filter_complex",
        "[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1[base];[base][1:v]overlay=0:0:enable='between(t,0,2.3)'[v]",
        "-map",
        "[v]",
        "-an",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-r",
        "30",
        labeledPath,
      ]);
      clipPaths.push(labeledPath);
    }

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

    const allVideos = [titleVideo, ...clipPaths];
    const segmentDurations = await Promise.all(
      allVideos.map((path) => probeDuration(path)),
    );
    const concatList = join(work, "concat.txt");
    await writeFile(
      concatList,
      allVideos.map((path) => `file '${path.replace(/'/g, "'\\''")}'`).join("\n"),
    );

    const body = join(work, "body.mp4");
    const fade = 0.15;
    const args = ["-y"];
    for (const path of allVideos) {
      args.push("-i", path);
    }
    args.push(
      "-filter_complex",
      xfadeFilter(segmentDurations, fade),
      "-map",
      "[vout]",
      "-an",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      body,
    );
    try {
      await execFileAsync("ffmpeg", args);
    } catch {
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
    }

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
