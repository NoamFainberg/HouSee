import { NextResponse } from "next/server";
import { hasHiggsfieldEnv } from "@/lib/env";
import { startClipRetry } from "@/lib/jobs";
import { getTourDetail } from "@/lib/tours";

export const runtime = "nodejs";

type RouteCtx = { params: Promise<{ id: string; clipId: string }> };

export async function POST(_request: Request, context: RouteCtx) {
  try {
    const { id, clipId } = await context.params;
    if (!hasHiggsfieldEnv()) {
      return NextResponse.json(
        { error: "Higgsfield is not configured." },
        { status: 400 },
      );
    }
    await startClipRetry(id, clipId);
    return NextResponse.json(await getTourDetail(id));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Retry failed" },
      { status: 500 },
    );
  }
}
