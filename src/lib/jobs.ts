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
  void runTourPipeline(tourId, options).catch((error) => {
    console.error("Inline tour pipeline failed", error);
  });
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
  void retryClipAndMaybeStitch(tourId, clipId, note).catch((error) => {
    console.error("Inline clip retry failed", error);
  });
}
