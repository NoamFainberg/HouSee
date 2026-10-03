import { NextResponse } from "next/server";
import { hasHiggsfieldEnv } from "@/lib/env";
import { startTourGeneration } from "@/lib/jobs";
import { isGenerationStale } from "@/lib/generation";
import { getTourDetail, mutateTour } from "@/lib/store";

export const runtime = "nodejs";

type RouteCtx = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: RouteCtx) {
  try {
    const { id } = await context.params;
    if (!hasHiggsfieldEnv()) {
      return NextResponse.json(
        {
          error:
            "Higgsfield is not configured. Add HF_API_KEY_ID and HF_API_KEY_SECRET to .env.local.",
        },
        { status: 400 },
      );
    }
    const current = await getTourDetail(id);
    if (["generating", "stitching"].includes(current.tour.status)) {
      if (!isGenerationStale(current.tour.updated_at)) {
        return NextResponse.json(current);
      }
      await mutateTour(id, (record) => {
        record.tour.error = null;
        record.tour.progress_label = "Resuming walkthrough…";
        record.tour.updated_at = new Date().toISOString();
      });
      await startTourGeneration(id, { resume: true });
      return NextResponse.json(await getTourDetail(id));
    }
    const included = current.photos.filter((photo) => !photo.rejected);
    if (included.length === 0) {
      return NextResponse.json(
        { error: "Include at least one photo before generating." },
        { status: 400 },
      );
    }
    await mutateTour(id, (record) => {
      record.tour.status = "generating";
      record.tour.error = null;
      record.tour.progress_label = "Queued…";
    });
    await startTourGeneration(id);
    return NextResponse.json(await getTourDetail(id));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not start generation" },
      { status: 500 },
    );
  }
}
