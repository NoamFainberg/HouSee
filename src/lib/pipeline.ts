import {
  CAMERA_PRESETS,
  clipLabel,
  ROOM_LABELS,
  transitionPrompt,
} from "./rooms";
import { hasHiggsfieldEnv, generationConcurrency } from "./env";
import {
  downloadBinary,
  pollGeneration,
  submitWalkthroughGeneration,
  uploadToHiggsfield,
} from "./higgsfield";
import { stitchTour } from "./stitch";
import {
  enrichClipPrompt,
  enrichTransitionPrompts,
} from "./vision";
import {
  mutateTour,
  readPhotoBytes,
  readTourRecord,
  writeClipBytes,
} from "./store";
import type { Clip, Photo, RoomType } from "./types";

export { isGenerationStale, STALE_GENERATION_MS } from "./generation";

function contentTypeForPhoto(photo: Photo): string {
  const ext = photo.storage_path.split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

export async function includedPhotos(tourId: string): Promise<Photo[]> {
  const record = await readTourRecord(tourId);
  return record.photos
    .filter((photo) => !photo.rejected)
    .sort((a, b) => a.sort_order - b.sort_order);
}

export async function buildClipPlan(tourId: string): Promise<Clip[]> {
  const photos = await includedPhotos(tourId);
  if (photos.length === 0) {
    throw new Error("No photos selected. Include at least one room photo.");
  }

  return mutateTour(tourId, (record) => {
    const now = new Date().toISOString();
    const clips: Clip[] = [];

    if (photos.length === 1) {
      const photo = photos[0]!;
      const room = photo.room_type;
      const preset = CAMERA_PRESETS[room];
      clips.push({
        id: crypto.randomUUID(),
        tour_id: tourId,
        photo_id: photo.id,
        end_photo_id: null,
        room_type: room,
        sort_order: 0,
        status: "pending",
        prompt: preset.prompt,
        camera_move: preset.move,
        higgsfield_request_id: null,
        video_path: null,
        video_url: null,
        error: null,
        created_at: now,
        updated_at: now,
      });
    } else {
      const plan = record.walkthrough_plan;
      const ordered = plan?.photo_sequence.length
        ? plan.photo_sequence
            .map((id) => photos.find((photo) => photo.id === id))
            .filter((photo): photo is Photo => Boolean(photo))
        : photos;

      let clipIndex = 0;

      // Chain one DoP morph per walk edge so each photo appears in sequence
      // (e.g. TV wall → window wall → seating). Clip N ends on photo N+1, which
      // is the opening frame of clip N+1 — no static hold, no hard jump.
      const morphPairs = ordered
        .slice(0, -1)
        .map((start, index) => [start, ordered[index + 1]!] as const);

      for (const [start, end] of morphPairs) {
        const edge = plan?.transitions.find(
          (item) =>
            item.from_photo_id === start.id && item.to_photo_id === end.id,
        );
        clips.push({
          id: crypto.randomUUID(),
          tour_id: tourId,
          photo_id: start.id,
          end_photo_id: end.id,
          room_type: start.room_type,
          sort_order: clipIndex,
          status: "pending",
          prompt:
            edge?.higgsfield_prompt ??
            transitionPrompt(start.room_type, end.room_type),
          camera_move: "spatial_blend",
          higgsfield_request_id: null,
          video_path: null,
          video_url: null,
          error: null,
          created_at: now,
          updated_at: now,
        });
        clipIndex += 1;
      }
    }

    record.clips = clips;
    record.tour.clip_count = clips.length;
    record.tour.current_clip_index = 0;
    return [...clips];
  });
}

async function higgsfieldUrlForPhoto(photo: Photo): Promise<string> {
  return uploadToHiggsfield(
    await readPhotoBytes(photo),
    contentTypeForPhoto(photo),
  );
}

function photoUploadCache(): Map<string, Promise<string>> {
  return new Map();
}

async function cachedHiggsfieldUrl(
  photo: Photo,
  cache: Map<string, Promise<string>>,
): Promise<string> {
  const existing = cache.get(photo.id);
  if (existing) return existing;
  const pending = higgsfieldUrlForPhoto(photo);
  cache.set(photo.id, pending);
  return pending;
}

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let nextIndex = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        await worker(items[index]!, index);
      }
    },
  );
  await Promise.all(runners);
}

function clipProgressLabel(label: string, status: string, elapsedMs: number) {
  const seconds = Math.max(1, Math.round(elapsedMs / 1000));
  if (status === "queued") {
    return `Queued ${label} on Higgsfield (${seconds}s)…`;
  }
  if (status === "in_progress" || status === "processing") {
    return `Rendering ${label} on Higgsfield (${seconds}s)…`;
  }
  return `Waiting on Higgsfield for ${label} (${status}, ${seconds}s)…`;
}

async function touchTourProgress(
  tourId: string,
  clipId: string,
  label: string,
  progressLabel: string,
) {
  await mutateTour(tourId, (current) => {
    current.tour.progress_label = progressLabel;
    current.tour.updated_at = new Date().toISOString();
    const target = current.clips.find((item) => item.id === clipId);
    if (target && target.status !== "completed") {
      target.status = "submitted";
      target.updated_at = new Date().toISOString();
    }
  });
}

export async function generateOneClip(
  tourId: string,
  clipId: string,
  uploadCache: Map<string, Promise<string>> = photoUploadCache(),
) {
  if (!hasHiggsfieldEnv()) {
    throw new Error(
      "Higgsfield credentials are missing. Set HF_API_KEY_ID and HF_API_KEY_SECRET.",
    );
  }

  const record = await readTourRecord(tourId);
  const clip = record.clips.find((item) => item.id === clipId);
  if (!clip) throw new Error("Clip not found");
  if (clip.status === "completed" && clip.video_path) return;
  if (!clip.photo_id) throw new Error("Clip is missing a start photo");

  const startPhoto = record.photos.find((photo) => photo.id === clip.photo_id);
  if (!startPhoto) throw new Error("Start photo not found");

  const endPhoto = clip.end_photo_id
    ? record.photos.find((photo) => photo.id === clip.end_photo_id)
    : undefined;
  const room = (clip.room_type as RoomType) ?? "other";
  const label = endPhoto
    ? clipLabel(room, endPhoto.room_type)
    : ROOM_LABELS[room];

  let requestId = clip.higgsfield_request_id;

  if (!requestId) {
    await touchTourProgress(
      tourId,
      clipId,
      label,
      `Uploading photos for ${label}…`,
    );

    const submitted = await submitWalkthroughGeneration({
      prompt: clip.prompt ?? CAMERA_PRESETS[startPhoto.room_type].prompt,
      startImageUrl: await cachedHiggsfieldUrl(startPhoto, uploadCache),
      endImageUrl: endPhoto
        ? await cachedHiggsfieldUrl(endPhoto, uploadCache)
        : undefined,
    });
    requestId = submitted.requestId;

    await mutateTour(tourId, (current) => {
      current.tour.progress_label = `Queued ${label} on Higgsfield…`;
      current.tour.updated_at = new Date().toISOString();
      const target = current.clips.find((item) => item.id === clipId);
      if (!target) return;
      target.status = "submitted";
      target.higgsfield_request_id = requestId;
      target.error = null;
      target.updated_at = new Date().toISOString();
    });
  } else {
    await touchTourProgress(
      tourId,
      clipId,
      label,
      `Resuming ${label} on Higgsfield…`,
    );
  }

  const videoUrl = await pollGeneration(requestId, {
    onStatus: async (status, elapsedMs) => {
      await touchTourProgress(
        tourId,
        clipId,
        label,
        clipProgressLabel(label, status, elapsedMs),
      );
    },
  });

  const storagePath = await writeClipBytes(
    tourId,
    clip.id,
    await downloadBinary(videoUrl),
  );

  await mutateTour(tourId, (current) => {
    const target = current.clips.find((item) => item.id === clipId);
    if (!target) return;
    target.status = "completed";
    target.higgsfield_request_id = requestId;
    target.video_path = storagePath;
    target.video_url = null;
    target.error = null;
    target.updated_at = new Date().toISOString();
    current.tour.updated_at = new Date().toISOString();
  });
}

async function sortedClips(tourId: string): Promise<Clip[]> {
  const record = await readTourRecord(tourId);
  return [...record.clips].sort((a, b) => a.sort_order - b.sort_order);
}

async function prepareResumeClips(tourId: string): Promise<Clip[]> {
  await mutateTour(tourId, (record) => {
    for (const clip of record.clips) {
      if (clip.status === "submitted" && !clip.higgsfield_request_id) {
        clip.status = "pending";
        clip.updated_at = new Date().toISOString();
      }
    }
  });
  return sortedClips(tourId);
}

export async function runTourPipeline(
  tourId: string,
  options?: { resume?: boolean },
) {
  try {
    await mutateTour(tourId, (record) => {
      record.tour.status = "generating";
      record.tour.error = null;
      record.tour.progress_label = options?.resume
        ? "Resuming walkthrough…"
        : "Building walkthrough plan…";
      if (!options?.resume) {
        record.tour.master_path = null;
      }
      record.tour.updated_at = new Date().toISOString();
    });

    const clips = options?.resume
      ? await prepareResumeClips(tourId)
      : await buildClipPlan(tourId);
    if (clips.length === 0) {
      throw new Error("No clips to generate.");
    }

    if (!options?.resume) {
      await enrichTransitionPrompts(tourId);
    }

    const refreshedClips = options?.resume
      ? await sortedClips(tourId)
      : clips;
    const photos = await includedPhotos(tourId);
    const pendingClips = refreshedClips.filter(
      (clip) => clip.status !== "completed",
    );
    const tourRecord = await readTourRecord(tourId);
    const concurrency =
      tourRecord.walkthrough_plan?.transitions.length && !options?.resume
        ? 1
        : generationConcurrency();
    const uploadCache = photoUploadCache();

    if (pendingClips.length > 0) {
      await mutateTour(tourId, (record) => {
        record.tour.status = "generating";
        record.tour.clip_count = refreshedClips.length;
        record.tour.progress_label =
          pendingClips.length > 1 && concurrency > 1
            ? `Rendering ${pendingClips.length} transitions in parallel…`
            : `Rendering ${pendingClips.length} transition…`;
        record.tour.updated_at = new Date().toISOString();
      });

      const failures: string[] = [];
      await mapWithConcurrency(
        pendingClips,
        concurrency,
        async (clip, index) => {
          const room = (clip.room_type as RoomType) ?? "other";
          const endPhoto = clip.end_photo_id
            ? photos.find((photo) => photo.id === clip.end_photo_id)
            : undefined;
          const label = endPhoto
            ? clipLabel(room, endPhoto.room_type)
            : ROOM_LABELS[room];

          await mutateTour(tourId, (record) => {
            record.tour.current_clip_index = index + 1;
            record.tour.progress_label =
              concurrency > 1
                ? `Rendering ${label} (${index + 1}/${pendingClips.length})…`
                : `Walking ${label} (${index + 1} of ${pendingClips.length})…`;
            record.tour.updated_at = new Date().toISOString();
          });

          try {
            await generateOneClip(tourId, clip.id, uploadCache);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Clip generation failed";
            await mutateTour(tourId, (record) => {
              const target = record.clips.find((item) => item.id === clip.id);
              if (target) {
                target.status = "failed";
                target.error = message;
                target.updated_at = new Date().toISOString();
              }
              record.tour.updated_at = new Date().toISOString();
            });
            failures.push(`${label} failed: ${message}`);
          }
        },
      );

      if (failures.length > 0) {
        throw new Error(failures[0]!);
      }
    }

    await mutateTour(tourId, (record) => {
      record.tour.status = "stitching";
      record.tour.progress_label = "Stitching master cut…";
      record.tour.updated_at = new Date().toISOString();
    });
    const masterPath = await stitchTour(tourId);
    await mutateTour(tourId, (record) => {
      record.tour.status = "complete";
      record.tour.master_path = masterPath;
      record.tour.progress_label = "Tour ready";
      record.tour.error = null;
      record.tour.updated_at = new Date().toISOString();
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Pipeline failed";
    await mutateTour(tourId, (record) => {
      record.tour.status = "failed";
      record.tour.error = message;
      record.tour.progress_label = "Generation failed";
      record.tour.updated_at = new Date().toISOString();
    });
    throw error;
  }
}

export async function retryClipAndMaybeStitch(tourId: string, clipId: string) {
  const record = await readTourRecord(tourId);
  const clip = record.clips.find((item) => item.id === clipId);
  if (!clip) throw new Error("Clip does not belong to this tour");

  const room = (clip.room_type as RoomType) ?? "other";
  const endPhoto = clip.end_photo_id
    ? record.photos.find((photo) => photo.id === clip.end_photo_id)
    : undefined;
  const label = endPhoto
    ? clipLabel(room, endPhoto.room_type)
    : ROOM_LABELS[room];

  await mutateTour(tourId, (current) => {
    current.tour.status = "generating";
    current.tour.error = null;
    current.tour.progress_label = `Retrying ${label}…`;
    current.tour.updated_at = new Date().toISOString();
    const target = current.clips.find((item) => item.id === clipId);
    if (target) {
      target.status = "pending";
      target.error = null;
      target.video_path = null;
      target.higgsfield_request_id = null;
      target.updated_at = new Date().toISOString();
    }
  });

  try {
    if (clip.end_photo_id) {
      await enrichClipPrompt(tourId, clipId);
    }
    await generateOneClip(tourId, clipId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Retry failed";
    await mutateTour(tourId, (current) => {
      const target = current.clips.find((item) => item.id === clipId);
      if (target) {
        target.status = "failed";
        target.error = message;
        target.updated_at = new Date().toISOString();
      }
      current.tour.status = "failed";
      current.tour.error = message;
      current.tour.progress_label = "Retry failed";
      current.tour.updated_at = new Date().toISOString();
    });
    throw error;
  }

  const refreshed = await readTourRecord(tourId);
  const pending = refreshed.clips.filter((item) => item.status !== "completed");
  if (pending.length > 0) {
    await runTourPipeline(tourId, { resume: true });
    return;
  }

  await mutateTour(tourId, (current) => {
    current.tour.status = "stitching";
    current.tour.progress_label = "Stitching master cut…";
    current.tour.updated_at = new Date().toISOString();
  });
  const masterPath = await stitchTour(tourId);
  await mutateTour(tourId, (current) => {
    current.tour.status = "complete";
    current.tour.master_path = masterPath;
    current.tour.progress_label = "Tour ready";
    current.tour.error = null;
    current.tour.updated_at = new Date().toISOString();
  });
}
