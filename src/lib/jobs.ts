import { pipelineDriver } from "@/lib/env";
import { inngest } from "@/inngest/client";
import {
  retryClipAndMaybeStitch,
  runTourPipeline,
} from "@/lib/pipeline";

export async function startTourGeneration(
  tourId: string,
  options?: { resume?: boolean },
) {
  if (pipelineDriver() === "inngest") {
    await inngest.send({
      name: "tour/generate",
      data: { tourId, resume: options?.resume ?? false },
    });
    return;
  }
  await runTourPipeline(tourId, options);
}

export async function startClipRetry(
  tourId: string,
  clipId: string,
  note?: string,
) {
  if (pipelineDriver() === "inngest") {
    await inngest.send({
      name: "clip/retry",
      data: { tourId, clipId, note },
    });
    return;
  }
  await retryClipAndMaybeStitch(tourId, clipId, note);
}
