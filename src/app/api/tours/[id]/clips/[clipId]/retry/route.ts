import { NextResponse } from "next/server";
import { hasHiggsfieldEnv } from "@/lib/env";
import { startClipRetry } from "@/lib/jobs";
import { getTourDetail } from "@/lib/tours";

export const runtime = "nodejs";

type RouteCtx = { params: Promise<{ id: string; clipId: string }> };

export async function POST(request: Request, context: RouteCtx) {
  try {
    const { id, clipId } = await context.params;
    if (!hasHiggsfieldEnv()) {
      return NextResponse.json(
        { error: "Higgsfield is not configured." },
        { status: 400 },
      );
    }
    let note: string | undefined;
    const raw = await request.text();
    if (raw.trim()) {
      const body = JSON.parse(raw) as { note?: unknown };
      if (typeof body.note === "string") note = body.note;
    }
    await startClipRetry(id, clipId, note);
    return NextResponse.json(await getTourDetail(id));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Retry failed" },
      { status: 500 },
    );
  }
}
