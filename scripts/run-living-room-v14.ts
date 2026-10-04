import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { runTourPipeline } from "../src/lib/pipeline";
import { createTour, mutateTour, tourDir } from "../src/lib/store";
import { curateTourPhotos } from "../src/lib/vision";

const SOURCE_TOUR = "e904c4e3-2ac7-4c64-9665-a036df0d9f3a";
const OUTPUT_ARTIFACT = "/opt/cursor/artifacts/living-room-spatial-v14.mp4";

async function clonePhotosFromSource(targetTourId: string) {
  const sourceDir = tourDir(SOURCE_TOUR);
  const targetDir = tourDir(targetTourId);
  const sourceRecord = JSON.parse(
    await readFile(path.join(sourceDir, "tour.json"), "utf8"),
  ) as {
    photos: {
      id: string;
      storage_path: string;
      original_filename: string | null;
      sort_order: number;
    }[];
  };

  await mkdir(path.join(targetDir, "photos"), { recursive: true });

  const now = new Date().toISOString();
  await mutateTour(targetTourId, (record) => {
    record.photos = sourceRecord.photos.map((photo) => ({
      id: crypto.randomUUID(),
      tour_id: targetTourId,
      storage_path: photo.storage_path,
      original_filename: photo.original_filename,
      room_type: "living",
      quality_score: null,
      rejected: false,
      reject_reason: null,
      sort_order: photo.sort_order,
      is_hero: photo.sort_order === 0,
      created_at: now,
    }));
  });

  const refreshed = JSON.parse(
    await readFile(path.join(targetDir, "tour.json"), "utf8"),
  ) as { photos: { id: string; storage_path: string }[] };

  for (const [index, photo] of refreshed.photos.entries()) {
    const sourcePhoto = sourceRecord.photos[index]!;
    const src = path.join(sourceDir, sourcePhoto.storage_path);
    const dest = path.join(targetDir, photo.storage_path);
    await copyFile(src, dest);
  }
}

async function main() {
  const tour = await createTour("Living room v14");
  console.log("Created tour", tour.id);
  await clonePhotosFromSource(tour.id);
  console.log("Cloned photos from", SOURCE_TOUR);
  await curateTourPhotos(tour.id);
  console.log("Curated photos and walkthrough plan");
  await runTourPipeline(tour.id);
  console.log("Pipeline complete");

  const master = path.join(tourDir(tour.id), "master.mp4");
  await copyFile(master, OUTPUT_ARTIFACT);
  console.log("Artifact:", OUTPUT_ARTIFACT);
  console.log("Tour ID:", tour.id);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
