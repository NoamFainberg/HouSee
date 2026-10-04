import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { clipDurationSeconds } from "./env";
import { absoluteMediaPath, readTourRecord, writeMasterBytes } from "./store";

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

async function titlePng(title: string): Promise<Buffer> {
  const safe = title.replace(/[<>&]/g, "");
  const svg = `<svg width="1920" height="1080" xmlns="http://www.w3.org/2000/svg">
    <rect width="1920" height="1080" fill="#16110C"/>
    <text x="160" y="500" font-family="Georgia, 'Times New Roman', serif" font-size="72" fill="#F6EFE4">${safe}</text>
    <text x="160" y="580" font-family="Georgia, 'Times New Roman', serif" font-size="28" fill="#C4A574">House tour</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
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
      const normalizedPath = join(work, `clip-${index}.mp4`);
      await copyFile(absoluteMediaPath(tourId, clip.video_path!), rawPath);
      await execFileAsync("ffmpeg", [
        "-y",
        "-i",
        rawPath,
        "-t",
        String(clipDuration),
        "-vf",
        "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1",
        "-an",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-r",
        "30",
        normalizedPath,
      ]);
      clipPaths.push(normalizedPath);
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
    const concatList = join(work, "concat.txt");
    await writeFile(
      concatList,
      allVideos.map((path) => `file '${path.replace(/'/g, "'\\''")}'`).join("\n"),
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
