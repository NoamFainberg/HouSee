import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { readPhotoBytes, writeClipBytes } from "./store";
import type { Photo } from "./types";

const execFileAsync = promisify(execFile);

export async function generatePhotoHoldClip(
  tourId: string,
  clipId: string,
  photo: Photo,
  seconds = 2.5,
): Promise<string> {
  const jpeg = await sharp(await readPhotoBytes(photo))
    .rotate()
    .jpeg({ quality: 90 })
    .toBuffer();
  const work = await mkdtemp(join(tmpdir(), "housee-hold-"));
  try {
    const input = join(work, "frame.jpg");
    const output = join(work, "hold.mp4");
    await writeFile(input, jpeg);
    await execFileAsync("ffmpeg", [
      "-y",
      "-loop",
      "1",
      "-i",
      input,
      "-t",
      String(seconds),
      "-vf",
      "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-an",
      output,
    ]);
    return writeClipBytes(tourId, clipId, await readFile(output));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
