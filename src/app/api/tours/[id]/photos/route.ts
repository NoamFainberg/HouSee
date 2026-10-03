import { NextResponse } from "next/server";
import sharp from "sharp";
import { addPhoto, getTourDetail } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_FILES = 4;
const MAX_BYTES = 12 * 1024 * 1024;
const ALLOWED = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/jpg",
  "image/avif",
]);

function isAllowedImage(file: File): boolean {
  if (ALLOWED.has(file.type)) return true;
  const ext = file.name.split(".").pop()?.toLowerCase();
  return ["jpg", "jpeg", "png", "webp", "avif"].includes(ext ?? "");
}

async function normalizeUpload(
  bytes: Buffer,
  contentType: string,
  filename: string,
): Promise<{ bytes: Buffer; contentType: string }> {
  const ext = filename.split(".").pop()?.toLowerCase();
  const isAvif = contentType === "image/avif" || ext === "avif";
  if (!isAvif) return { bytes, contentType };
  const jpeg = await sharp(bytes).rotate().jpeg({ quality: 90 }).toBuffer();
  return { bytes: jpeg, contentType: "image/jpeg" };
}

type RouteCtx = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteCtx) {
  try {
    const { id } = await context.params;
    const form = await request.formData();
    const files = form
      .getAll("files")
      .filter((value): value is File => value instanceof File);

    if (files.length === 0) {
      return NextResponse.json({ error: "No photos uploaded" }, { status: 400 });
    }
    if (files.length > MAX_FILES) {
      return NextResponse.json(
        { error: `Upload at most ${MAX_FILES} photos per request` },
        { status: 400 },
      );
    }

    for (const file of files) {
      if (!isAllowedImage(file)) {
        return NextResponse.json(
          { error: `Unsupported type: ${file.type || file.name}` },
          { status: 400 },
        );
      }
      if (file.size > MAX_BYTES) {
        return NextResponse.json(
          { error: `${file.name} is larger than 12MB` },
          { status: 400 },
        );
      }
      const raw = Buffer.from(await file.arrayBuffer());
      const normalized = await normalizeUpload(raw, file.type, file.name);
      await addPhoto(id, normalized.bytes, file.name, normalized.contentType);
    }

    return NextResponse.json(await getTourDetail(id));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed" },
      { status: 400 },
    );
  }
}
