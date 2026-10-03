import { NextResponse } from "next/server";
import { curateTourPhotos } from "@/lib/vision";
import { getTourDetail } from "@/lib/tours";

export const runtime = "nodejs";
export const maxDuration = 300;

type RouteCtx = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: RouteCtx) {
  try {
    const { id } = await context.params;
    await curateTourPhotos(id);
    return NextResponse.json(await getTourDetail(id));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Curation failed" },
      { status: 500 },
    );
  }
}
