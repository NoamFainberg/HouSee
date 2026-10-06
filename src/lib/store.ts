import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Clip, Photo, Tour, TourDetail } from "./types";
import {
  catalogTourIds,
  fetchPublishedTour,
  fetchRemoteFile,
  publishTourRecord,
  uploadTourBytes,
  usesEphemeralDisk,
} from "./vercel-tour-store";

export type WalkthroughTransitionPlan = {
  from_photo_id: string;
  to_photo_id: string;
  connection_score: number;
  spatial_relationship: string;
  shared_elements: string[];
  camera_path: string;
  can_blend: boolean;
  avoid: string[];
  higgsfield_prompt: string;
};

export type WalkthroughPhotoView = {
  photo_id: string;
  view_angle: string;
};

export type WalkthroughPlan = {
  scene_summary: string;
  photo_sequence: string[];
  photo_views?: WalkthroughPhotoView[];
  transitions: WalkthroughTransitionPlan[];
  analyzed_at: string;
};

export type TourRecord = {
  tour: Tour;
  photos: Photo[];
  clips: Clip[];
  walkthrough_plan?: WalkthroughPlan;
  /** Public file URLs used when the server disk does not persist (Vercel). */
  remote_files?: Record<string, string>;
};

function dataRoot() {
  if (usesEphemeralDisk()) return "/tmp/housee/tours";
  return path.join(process.cwd(), "data", "tours");
}

function assertTourId(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    throw new Error("Invalid tour id");
  }
}

export function tourDir(id: string) {
  assertTourId(id);
  return path.join(dataRoot(), id);
}

export function absoluteMediaPath(tourId: string, relativePath: string) {
  const root = tourDir(tourId);
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error("Invalid media path");
  }
  return resolved;
}

export function mediaUrl(tourId: string, relativePath: string) {
  return `/api/media/${tourId}/${relativePath.split(path.sep).join("/")}`;
}

async function cacheTourRecord(record: TourRecord) {
  const file = path.join(tourDir(record.tour.id), "tour.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
}

export async function readTourRecord(id: string): Promise<TourRecord> {
  assertTourId(id);
  if (usesEphemeralDisk()) {
    const published = await fetchPublishedTour(id);
    if (published) {
      await cacheTourRecord(published);
      return published;
    }
  }
  const file = path.join(tourDir(id), "tour.json");
  const raw = await readFile(file, "utf8");
  return JSON.parse(raw) as TourRecord;
}

const writeLocks = new Map<string, Promise<unknown>>();

export async function mutateTour<T>(
  id: string,
  mutator: (record: TourRecord) => T | Promise<T>,
): Promise<T> {
  const previous = writeLocks.get(id) ?? Promise.resolve();
  let release: (value: unknown) => void = () => undefined;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  writeLocks.set(id, previous.then(() => gate));
  await previous.catch(() => undefined);
  try {
    const record = await readTourRecord(id);
    const result = await mutator(record);
    record.tour.updated_at = new Date().toISOString();
    await cacheTourRecord(record);
    if (usesEphemeralDisk()) await publishTourRecord(record);
    return result;
  } finally {
    release(undefined);
  }
}

export async function createTour(title: string): Promise<Tour> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const tour: Tour = {
    id,
    title,
    status: "draft",
    progress_label: "Upload listing photos",
    current_clip_index: 0,
    clip_count: 0,
    master_path: null,
    error: null,
    created_at: now,
    updated_at: now,
  };
  const dir = tourDir(id);
  await mkdir(path.join(dir, "photos"), { recursive: true });
  await mkdir(path.join(dir, "clips"), { recursive: true });
  const record: TourRecord = { tour, photos: [], clips: [] };
  await cacheTourRecord(record);
  if (usesEphemeralDisk()) await publishTourRecord(record);
  return tour;
}

export async function listTours(): Promise<Tour[]> {
  await mkdir(dataRoot(), { recursive: true });
  const ids = new Set<string>();
  if (usesEphemeralDisk()) {
    for (const id of await catalogTourIds()) ids.add(id);
  } else {
    const entries = await readdir(dataRoot(), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) ids.add(entry.name);
    }
  }
  const tours: Tour[] = [];
  for (const id of ids) {
    try {
      const record = await readTourRecord(id);
      tours.push(record.tour);
    } catch {
      // skip incomplete folders
    }
  }
  return tours.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 20);
}

export function toTourDetail(record: TourRecord): TourDetail {
  const { tour, photos, clips } = record;
  return {
    tour,
    photos: [...photos]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((photo) => ({
        ...photo,
        url: mediaUrl(tour.id, photo.storage_path),
      })),
    clips: [...clips]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((clip) => ({
        ...clip,
        playbackUrl: clip.video_path
          ? mediaUrl(tour.id, clip.video_path)
          : clip.video_url,
      })),
    masterUrl: tour.master_path ? mediaUrl(tour.id, tour.master_path) : null,
  };
}

export async function getTourDetail(tourId: string): Promise<TourDetail> {
  return toTourDetail(await readTourRecord(tourId));
}

export async function addPhoto(
  tourId: string,
  bytes: Buffer,
  filename: string,
  contentType: string,
): Promise<Photo> {
  const ext =
    contentType === "image/png"
      ? "png"
      : contentType === "image/webp"
        ? "webp"
        : "jpg";
  const photoId = crypto.randomUUID();
  const storagePath = path.join("photos", `${photoId}.${ext}`);
  const dest = absoluteMediaPath(tourId, storagePath);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, bytes);
  const normalizedPath = storagePath.split(path.sep).join("/");
  const remoteUrl = usesEphemeralDisk()
    ? await uploadTourBytes(normalizedPath, bytes, contentType)
    : undefined;
  return mutateTour(tourId, (record) => {
    const nextOrder =
      record.photos.reduce((max, photo) => Math.max(max, photo.sort_order), -1) +
      1;
    const photo: Photo = {
      id: photoId,
      tour_id: tourId,
      storage_path: normalizedPath,
      original_filename: filename,
      room_type: "other",
      quality_score: null,
      rejected: false,
      reject_reason: null,
      sort_order: nextOrder,
      is_hero: false,
      created_at: new Date().toISOString(),
    };
    record.photos.push(photo);
    if (remoteUrl) {
      record.remote_files = { ...record.remote_files, [normalizedPath]: remoteUrl };
    }
    record.tour.progress_label = "Photos uploaded";
    return photo;
  });
}

export async function readMediaBytes(
  tourId: string,
  relativePath: string,
): Promise<Buffer> {
  const normalized = relativePath.split(path.sep).join("/");
  const local = absoluteMediaPath(tourId, normalized);
  try {
    return await readFile(local);
  } catch (error) {
    if (!usesEphemeralDisk()) throw error;
    const record = await readTourRecord(tourId);
    const url = record.remote_files?.[normalized];
    if (!url) throw error;
    const bytes = await fetchRemoteFile(url);
    await mkdir(path.dirname(local), { recursive: true });
    await writeFile(local, bytes);
    return bytes;
  }
}

export async function readPhotoBytes(photo: Photo): Promise<Buffer> {
  return readMediaBytes(photo.tour_id, photo.storage_path);
}

export async function writeClipBytes(
  tourId: string,
  clipId: string,
  bytes: Buffer,
): Promise<string> {
  const storagePath = `clips/${clipId}.mp4`;
  await mkdir(path.join(tourDir(tourId), "clips"), { recursive: true });
  await writeFile(absoluteMediaPath(tourId, storagePath), bytes);
  if (usesEphemeralDisk()) {
    const remoteUrl = await uploadTourBytes(storagePath, bytes, "video/mp4");
    await mutateTour(tourId, (record) => {
      record.remote_files = { ...record.remote_files, [storagePath]: remoteUrl };
    });
  }
  return storagePath;
}

export async function writeMasterBytes(
  tourId: string,
  bytes: Buffer,
): Promise<string> {
  const storagePath = "master.mp4";
  await mkdir(tourDir(tourId), { recursive: true });
  await writeFile(absoluteMediaPath(tourId, storagePath), bytes);
  if (usesEphemeralDisk()) {
    const remoteUrl = await uploadTourBytes(storagePath, bytes, "video/mp4");
    await mutateTour(tourId, (record) => {
      record.remote_files = { ...record.remote_files, [storagePath]: remoteUrl };
    });
  }
  return storagePath;
}
