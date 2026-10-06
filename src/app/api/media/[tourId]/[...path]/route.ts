import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { readMediaBytes } from "@/lib/store";

export const runtime = "nodejs";

const TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
};

type RouteCtx = { params: Promise<{ tourId: string; path: string[] }> };

export async function GET(_request: NextRequest, context: RouteCtx) {
  try {
    const { tourId, path: segments } = await context.params;
    if (!segments?.length) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const relative = segments.join("/");
    const bytes = await readMediaBytes(tourId, relative);
    const ext = path.extname(relative).toLowerCase();
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": TYPES[ext] ?? "application/octet-stream",
        "Cache-Control": "private, max-age=60",
      },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
