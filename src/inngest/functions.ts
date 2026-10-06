import { generateOneClip, runTourPipeline, retryClipAndMaybeStitch } from "@/lib/pipeline";
import { inngest } from "./client";

export const generateTourFn = inngest.createFunction(
  {
    id: "generate-tour",
    triggers: [{ event: "tour/generate" }],
    timeouts: { finish: "2h" },
  },
  async ({ event, step }) => {
    const tourId = event.data.tourId as string;
    await step.run("run-pipeline", () =>
      runTourPipeline(tourId, {
        resume: Boolean(event.data.resume),
      }),
    );
    return { tourId };
  },
);

export const retryClipFn = inngest.createFunction(
  {
    id: "retry-clip",
    triggers: [{ event: "clip/retry" }],
    timeouts: { finish: "30m" },
  },
  async ({ event, step }) => {
    const tourId = event.data.tourId as string;
    const clipId = event.data.clipId as string;
    const note =
      typeof event.data.note === "string" ? event.data.note : undefined;
    await step.run("retry-clip", () =>
      retryClipAndMaybeStitch(tourId, clipId, note),
    );
    return { tourId, clipId };
  },
);

export const generateClipFn = inngest.createFunction(
  {
    id: "generate-clip",
    triggers: [{ event: "clip/generate" }],
    timeouts: { finish: "20m" },
  },
  async ({ event, step }) => {
    const tourId = event.data.tourId as string;
    const clipId = event.data.clipId as string;
    await step.run("generate-one-clip", () => generateOneClip(tourId, clipId));
    return { tourId, clipId };
  },
);

export const inngestFunctions = [generateTourFn, retryClipFn, generateClipFn];
