import { cookies } from "next/headers";
import { uploadToHiggsfield } from "./higgsfield";
import type { TourRecord } from "./store";

const COOKIE = "housee_catalog";
const MAX_TOURS = 15;

export function usesEphemeralDisk(): boolean {
  return process.env.VERCEL === "1";
}

/** Higgsfield only accepts media content types. JSON is uploaded as image/png and returned as raw bytes. */
function uploadContentType(relativePath: string, fallback: string): string {
  const ext = relativePath.split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "mp4") return "video/mp4";
  if (fallback.startsWith("image/") || fallback.startsWith("video/")) return fallback;
  return "image/png";
}

export async function uploadTourBytes(
  relativePath: string,
  bytes: Buffer,
  contentType: string,
): Promise<string> {
  return uploadToHiggsfield(bytes, uploadContentType(relativePath, contentType));
}

async function readCatalog(): Promise<Record<string, string>> {
  try {
    const jar = await cookies();
    const raw = jar.get(COOKIE)?.value;
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, string>;
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

async function writeCatalog(catalog: Record<string, string>) {
  const entries = Object.entries(catalog).slice(-MAX_TOURS);
  const jar = await cookies();
  jar.set(COOKIE, JSON.stringify(Object.fromEntries(entries)), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 14,
  });
}

export async function catalogTourIds(): Promise<string[]> {
  return Object.keys(await readCatalog());
}

export async function publishTourRecord(record: TourRecord): Promise<void> {
  const url = await uploadTourBytes(
    "tour.json",
    Buffer.from(JSON.stringify(record)),
    "application/json",
  );
  const catalog = await readCatalog();
  catalog[record.tour.id] = url;
  await writeCatalog(catalog);
}

export async function fetchPublishedTour(id: string): Promise<TourRecord | null> {
  const url = (await readCatalog())[id];
  if (!url) return null;
  const response = await fetch(url);
  if (!response.ok) return null;
  return JSON.parse(await response.text()) as TourRecord;
}

export async function fetchRemoteFile(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not read saved tour file (${response.status})`);
  }
  return Buffer.from(await response.arrayBuffer());
}
