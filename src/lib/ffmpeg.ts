import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import ffmpegStatic from "ffmpeg-static";

const execFileAsync = promisify(execFile);

let resolved: Promise<string> | null = null;

/** System ffmpeg when present, otherwise the static binary shipped with the app. */
export function ffmpegBinary(): Promise<string> {
  if (!resolved) resolved = resolveFfmpeg();
  return resolved;
}

async function resolveFfmpeg(): Promise<string> {
  try {
    await execFileAsync("ffmpeg", ["-version"]);
    return "ffmpeg";
  } catch {
    return bundledFfmpeg();
  }
}

async function bundledFfmpeg(): Promise<string> {
  if (!ffmpegStatic) {
    throw new Error("ffmpeg is not available on this host.");
  }
  try {
    await access(ffmpegStatic, constants.X_OK);
    return ffmpegStatic;
  } catch {
    // Serverless traces sometimes drop the executable bit on a read-only mount.
  }
  try {
    await access(ffmpegStatic);
  } catch {
    throw new Error("ffmpeg is not available on this host.");
  }
  const dest = join(tmpdir(), "housee-ffmpeg");
  try {
    await access(dest, constants.X_OK);
    return dest;
  } catch {
    await copyFile(ffmpegStatic, dest);
    await chmod(dest, 0o755);
    return dest;
  }
}
