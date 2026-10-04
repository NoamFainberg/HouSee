import { stitchTour } from "../src/lib/stitch";
import { mutateTour } from "../src/lib/store";

const tourId = process.argv[2];
if (!tourId) {
  console.error("Usage: npx tsx scripts/restitch-tour.ts <tourId>");
  process.exit(1);
}

async function main() {
  const masterPath = await stitchTour(tourId);
  await mutateTour(tourId, (record) => {
    record.tour.status = "complete";
    record.tour.master_path = masterPath;
    record.tour.progress_label = "Tour ready";
    record.tour.error = null;
    record.tour.updated_at = new Date().toISOString();
  });
  console.log(masterPath);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
