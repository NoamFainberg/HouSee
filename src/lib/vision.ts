import sharp from "sharp";
import {
  CINEMATIC_PROMPT_PREFIX,
  inferRoomFromFilename,
  isRoomType,
  ROOM_LABELS,
  transitionPrompt,
  walkthroughRank,
} from "./rooms";
import { mutateTour, readPhotoBytes, readTourRecord } from "./store";
import type { Photo, RoomType } from "./types";

type VisionTag = {
  index: number;
  room_type: RoomType;
  reject: boolean;
  reject_reason: string | null;
  quality: number;
  duplicate_of: number | null;
};

export type TransitionPlan = {
  connection_score: number;
  shared_elements: string[];
  camera_path: string;
  higgsfield_prompt: string;
};

type VisionImage = {
  label: string;
  base64: string;
};

const VISION_PROMPT = `You are tagging Airbnb/listing photos for a cinematic house-tour video.

For each image (in order, 0-based index) return JSON:
{"photos":[{"index":0,"room_type":"living","reject":false,"reject_reason":null,"quality":0.82,"duplicate_of":null}]}

room_type must be one of:
exterior, entry, living, kitchen, dining, bedroom, bathroom, balcony, view, amenity, other, floorplan

Reject (reject=true) floor plans, maps, screenshots, logos, collages, extreme close-ups of clutter, and near-duplicates (set duplicate_of to the earlier index).
quality is 0-1: prefer wide, well-lit, straight-on interior/exterior photos.
Return JSON only.`;

function transitionVisionPrompt(fromLabel: string, toLabel: string): string {
  return `You are a cinematographer planning a seamless image-to-image video morph for a real-estate walkthrough.

Image START is the opening frame (${fromLabel}).
Image END is the closing frame (${toLabel}).

Study both photos carefully:
- Identify shared architecture: doorways, hallways, floors, walls, windows, sightlines
- Determine if END is visible from START (through a door, down a hall, around a corner)
- Choose a camera move that exists in the actual space — never invent doors, windows, or rooms

Return JSON only:
{
  "connection_score": 0.0,
  "shared_elements": ["list visible elements that appear in both frames"],
  "camera_path": "one sentence describing the exact camera move through visible space",
  "avoid": ["things the video model must not hallucinate"],
  "higgsfield_prompt": "complete prompt for the video model"
}

Rules for higgsfield_prompt:
- Must begin with: "${CINEMATIC_PROMPT_PREFIX}"
- Opening frame must match START exactly; closing frame must match END exactly
- Describe ONLY motion through architecture visible in START toward what appears in END
- If a real doorway/opening connects the spaces, use it; if not, use a slow pan or dolly that stays inside START while gradually matching END lighting and geometry
- Never say "walk through a door" unless that exact opening is visible in START
- No people, no text overlays, stable walls and furniture
- Keep higgsfield_prompt under 450 characters`;
}

export function hasVisionEnv(): boolean {
  return Boolean(
    process.env.OPENAI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  );
}

function parseTags(raw: string, count: number): VisionTag[] {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return [];
  const parsed = JSON.parse(match[0]) as { photos?: VisionTag[] };
  const photos = parsed.photos ?? [];
  return photos.filter((tag) => tag.index >= 0 && tag.index < count);
}

async function imageToJpegBase64(
  buffer: Buffer,
  maxSize = 768,
): Promise<string> {
  const jpeg = await sharp(buffer)
    .rotate()
    .resize(maxSize, maxSize, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: maxSize <= 512 ? 68 : 72 })
    .toBuffer();
  return jpeg.toString("base64");
}

async function callOpenAI(
  textPrompt: string,
  images: VisionImage[],
): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("no openai");
  const content: unknown[] = [{ type: "text", text: textPrompt }];
  for (const image of images) {
    content.push({ type: "text", text: image.label });
    content.push({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${image.base64}` },
    });
  }
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content }],
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI vision failed: ${await response.text()}`);
  }
  const json = (await response.json()) as {
    choices: { message: { content: string } }[];
  };
  return json.choices[0]?.message.content ?? "{}";
}

async function callGemini(
  textPrompt: string,
  images: VisionImage[],
): Promise<string> {
  const key = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!key) throw new Error("no gemini");
  const parts: unknown[] = [{ text: textPrompt }];
  for (const image of images) {
    parts.push({ text: image.label });
    parts.push({
      inline_data: { mime_type: "image/jpeg", data: image.base64 },
    });
  }
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
        },
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Gemini vision failed: ${await response.text()}`);
  }
  const json = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  return json.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
}

async function callVision(
  textPrompt: string,
  images: VisionImage[],
): Promise<string> {
  const attempts = [
    process.env.GOOGLE_GENERATIVE_AI_API_KEY
      ? () => callGemini(textPrompt, images)
      : null,
    process.env.OPENAI_API_KEY ? () => callOpenAI(textPrompt, images) : null,
  ].filter(Boolean) as (() => Promise<string>)[];

  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      console.warn("Vision provider failed", error);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("No vision provider available");
}

function parseTransitionPlan(raw: string, fallback: string): TransitionPlan {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("no json");
    const parsed = JSON.parse(match[0]) as {
      connection_score?: number;
      shared_elements?: string[];
      camera_path?: string;
      higgsfield_prompt?: string;
    };
    let prompt = parsed.higgsfield_prompt?.trim() ?? "";
    if (prompt.length < 40) throw new Error("prompt too short");
    if (!prompt.startsWith("Photoreal")) {
      prompt = `${CINEMATIC_PROMPT_PREFIX} ${prompt}`;
    }
    return {
      connection_score: Math.min(
        1,
        Math.max(0, Number(parsed.connection_score) || 0.5),
      ),
      shared_elements: Array.isArray(parsed.shared_elements)
        ? parsed.shared_elements.map(String)
        : [],
      camera_path: parsed.camera_path?.trim() ?? "",
      higgsfield_prompt: prompt,
    };
  } catch {
    return {
      connection_score: 0,
      shared_elements: [],
      camera_path: "",
      higgsfield_prompt: fallback,
    };
  }
}

export async function planTransitionPair(
  start: Photo,
  end: Photo,
): Promise<TransitionPlan> {
  const fallback = transitionPrompt(start.room_type, end.room_type);
  if (!hasVisionEnv()) {
    return parseTransitionPlan("", fallback);
  }

  const [startBase64, endBase64] = await Promise.all([
    imageToJpegBase64(await readPhotoBytes(start), 512),
    imageToJpegBase64(await readPhotoBytes(end), 512),
  ]);

  const raw = await callVision(
    transitionVisionPrompt(
      ROOM_LABELS[start.room_type],
      ROOM_LABELS[end.room_type],
    ),
    [
      { label: "Image START (opening frame):", base64: startBase64 },
      { label: "Image END (closing frame):", base64: endBase64 },
    ],
  );

  const plan = parseTransitionPlan(raw, fallback);
  if (plan.shared_elements.length > 0 && plan.camera_path) {
    const anchors = plan.shared_elements.slice(0, 3).join(", ");
    plan.higgsfield_prompt = `${plan.higgsfield_prompt} Shared elements: ${anchors}. ${plan.camera_path}`;
  }
  if (plan.higgsfield_prompt.length > 900) {
    plan.higgsfield_prompt = plan.higgsfield_prompt.slice(0, 897) + "…";
  }
  return plan;
}

async function tagBatch(photos: Photo[]): Promise<VisionTag[]> {
  const images = await Promise.all(
    photos.map(async (photo, index) => ({
      label: `Image index ${index}`,
      base64: await imageToJpegBase64(await readPhotoBytes(photo)),
    })),
  );

  if (hasVisionEnv()) {
    try {
      return parseTags(await callVision(VISION_PROMPT, images), photos.length);
    } catch (error) {
      console.warn("Vision provider failed", error);
    }
  }

  return photos.map((photo, index) => {
    const room_type = inferRoomFromFilename(photo.original_filename ?? "");
    return {
      index,
      room_type,
      reject: room_type === "floorplan",
      reject_reason: room_type === "floorplan" ? "floorplan" : null,
      quality: 0.5,
      duplicate_of: null,
    };
  });
}

export async function enrichClipPrompt(
  tourId: string,
  clipId: string,
): Promise<string | null> {
  const record = await readTourRecord(tourId);
  const clip = record.clips.find((item) => item.id === clipId);
  if (!clip?.photo_id || !clip.end_photo_id) return clip?.prompt ?? null;

  const start = record.photos.find((photo) => photo.id === clip.photo_id);
  const end = record.photos.find((photo) => photo.id === clip.end_photo_id);
  if (!start || !end) return clip.prompt;

  const plan = await planTransitionPair(start, end);
  await mutateTour(tourId, (current) => {
    const target = current.clips.find((item) => item.id === clipId);
    if (!target) return;
    target.prompt = plan.higgsfield_prompt;
    target.updated_at = new Date().toISOString();
  });
  return plan.higgsfield_prompt;
}

export async function enrichTransitionPrompts(tourId: string): Promise<void> {
  if (!hasVisionEnv()) return;

  const record = await readTourRecord(tourId);
  const transitionClips = record.clips.filter((clip) => clip.end_photo_id);
  if (transitionClips.length === 0) return;

  await mutateTour(tourId, (current) => {
    current.tour.progress_label = `Analyzing ${transitionClips.length} photo connection${transitionClips.length === 1 ? "" : "s"}…`;
    current.tour.updated_at = new Date().toISOString();
  });

  await Promise.all(
    transitionClips.map((clip) => enrichClipPrompt(tourId, clip.id)),
  );
}

export async function curateTourPhotos(tourId: string) {
  await mutateTour(tourId, (record) => {
    record.tour.status = "curating";
    record.tour.progress_label = "Tagging rooms…";
  });

  const typed = (await readTourRecord(tourId)).photos.sort(
    (a, b) => a.sort_order - b.sort_order,
  );
  const tagsByIndex = new Map<number, VisionTag>();
  const batchSize = 6;
  for (let i = 0; i < typed.length; i += batchSize) {
    const slice = typed.slice(i, i + batchSize);
    const tags = await tagBatch(slice);
    for (const tag of tags) {
      tagsByIndex.set(i + tag.index, { ...tag, index: i + tag.index });
    }
  }

  const bestByRoom = new Map<RoomType, { index: number; quality: number }>();
  const updates = typed.map((photo, index) => {
    const tag = tagsByIndex.get(index);
    const roomType: RoomType =
      tag?.room_type && isRoomType(tag.room_type)
        ? tag.room_type
        : inferRoomFromFilename(photo.original_filename ?? "");
    const quality = tag?.quality ?? 0.5;
    const rejected =
      Boolean(tag?.reject) ||
      roomType === "floorplan" ||
      tag?.duplicate_of != null;
    const rejectReason =
      tag?.reject_reason ??
      (roomType === "floorplan"
        ? "floorplan"
        : tag?.duplicate_of != null
          ? "duplicate"
          : null);

    if (!rejected) {
      const current = bestByRoom.get(roomType);
      if (!current || quality > current.quality) {
        bestByRoom.set(roomType, { index, quality });
      }
    }

    return {
      id: photo.id,
      room_type: roomType,
      quality_score: quality,
      rejected,
      reject_reason: rejectReason,
    };
  });

  await mutateTour(tourId, (record) => {
    for (const update of updates) {
      const photo = record.photos.find((item) => item.id === update.id);
      if (!photo) continue;
      const heroIndex = bestByRoom.get(update.room_type)?.index;
      photo.room_type = update.room_type;
      photo.quality_score = update.quality_score;
      photo.rejected = update.rejected;
      photo.reject_reason = update.reject_reason;
      photo.is_hero =
        heroIndex !== undefined &&
        typed[heroIndex]?.id === update.id &&
        !update.rejected;
    }

    record.photos.sort((a, b) => {
      if (a.rejected !== b.rejected) return a.rejected ? 1 : -1;
      const rank = walkthroughRank(a.room_type) - walkthroughRank(b.room_type);
      if (rank !== 0) return rank;
      return (b.quality_score ?? 0) - (a.quality_score ?? 0);
    });
    record.photos.forEach((photo, index) => {
      photo.sort_order = index;
    });

    record.tour.status = "ready";
    record.tour.progress_label = hasVisionEnv()
      ? "Rooms tagged with vision. Reorder if needed, then generate."
      : "Rooms tagged. Reorder if needed, then generate.";
    record.tour.error = null;
  });
}
