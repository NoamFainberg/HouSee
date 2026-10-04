import sharp from "sharp";
import {
  CINEMATIC_PROMPT_PREFIX,
  inferRoomFromFilename,
  inferSameRoomViewRole,
  isRoomType,
  orderSameRoomWalkPhotos,
  ROOM_LABELS,
  transitionPrompt,
} from "./rooms";
import type { WalkthroughPlan, WalkthroughTransitionPlan } from "./store";
import { mutateTour, readPhotoBytes, readTourRecord } from "./store";
import type { Photo, RoomType } from "./types";
import { visionPlanningModel } from "./env";

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

Reject (reject=true) only floor plans, maps, screenshots, logos, and collages.
Multiple wide angles of the same room are intentional — keep reject=false for each. Only set duplicate_of when two images are nearly pixel-identical; different camera positions of one room are NOT duplicates.
quality is 0-1: prefer wide, well-lit, straight-on interior/exterior photos.
Return JSON only.`;

function walkthroughPlanPrompt(photoCount: number): string {
  return `You are a cinematographer and spatial-reasoning planner for a real-estate walkthrough video.

You receive ${photoCount} photographs of the same property, possibly the same room from different positions. Study ALL images together before deciding anything.

Your tasks:
1. Identify anchor elements that repeat across photos (floor material, ceiling lights, specific sofa, TV, window wall, etc.)
2. Infer how the camera positions relate in real space (e.g. "photo 1 faces the TV wall; photo 2 is panned left toward the window")
3. Order the photos into a walk sequence where each consecutive step could be filmed by a real camera move without passing through walls
4. For each consecutive pair in that sequence, write the exact Higgsfield image-to-video morph prompt

Return JSON only:
{
  "scene_summary": "one sentence describing the space",
  "sequence": [0, 1, 2],
  "photos": [
    {
      "index": 0,
      "room_type": "living",
      "camera_note": "where the camera stands and what it faces",
      "anchors": ["elements unique to or visible in this frame"],
      "reject": false
    }
  ],
  "transitions": [
    {
      "from_index": 0,
      "to_index": 1,
      "connection_score": 0.85,
      "spatial_relationship": "how the two camera positions connect in the real room",
      "shared_elements": ["only elements clearly visible in BOTH frames"],
      "camera_path": "exact in-room move, e.g. slow 30-degree pan left along the floor plane",
      "can_blend": true,
      "avoid": ["invented doorways", "people", "cameras", "equipment", "flying doors", "new windows"],
      "higgsfield_prompt": "complete prompt for the video model"
    }
  ]
}

CRITICAL RULES:
- sequence must list every non-rejected photo index exactly once (${photoCount} indices total, 0-based)
- can_blend=true ONLY when shared_elements are genuinely visible in BOTH frames and a real camera move could connect them without hallucination
- higgsfield_prompt MUST begin with: "${CINEMATIC_PROMPT_PREFIX}"
- Opening frame must match from_index exactly; closing frame must match to_index exactly
- Motion stays inside visible geometry — NEVER pass through solid walls, NEVER add doorways/windows/people/cameras/tripods not in the start frame
- Reference shared anchors by name so the model locks geometry
- Forbidden words in higgsfield_prompt: "walk through door" unless that exact opening is visible in the start frame
- If two views cannot connect without hallucination, set can_blend=false and explain why
- Keep each higgsfield_prompt under 420 characters
- room_type must be one of: exterior, entry, living, kitchen, dining, bedroom, bathroom, balcony, view, amenity, other, floorplan
- Same-room wide rotation (>25° between views): use locked tripod, yaw-only, max 20° pan — NEVER translate the camera through the room or pass through walls/door frames visible in START
- Name solid walls and door frames in START that must stay closed and fixed`;
}

const CONSERVATIVE_MORPH_AVOID = [
  "passing through walls",
  "opening doors",
  "forward dolly",
  "translating camera",
  "walking through doorways",
  "people",
  "cameras",
  "equipment",
  "flying doors",
];

function parsePanDegrees(cameraPath: string): number | null {
  const match = cameraPath.match(/(\d+)\s*-?\s*degree/i);
  return match ? Number(match[1]) : null;
}

export function tuneTransitionPrompt(
  edge: WalkthroughTransitionPlan,
  transitionIndex: number,
  start: Photo,
  end: Photo,
): WalkthroughTransitionPlan {
  const sameRoom = start.room_type === end.room_type;
  const degrees = parsePanDegrees(edge.camera_path);
  const establishToNext =
    inferSameRoomViewRole(start.original_filename ?? "") === "establish" &&
    inferSameRoomViewRole(end.original_filename ?? "") === "feature";
  const needsConservative =
    sameRoom &&
    (transitionIndex === 0 ||
      establishToNext ||
      (degrees !== null && degrees > 25));

  if (!needsConservative) {
    return edge;
  }

  const maxPan = establishToNext ? 15 : 20;
  const avoid = [...new Set([...edge.avoid, ...CONSERVATIVE_MORPH_AVOID])];
  const cameraPath = `Locked tripod, yaw-only rotation, max ${maxPan}-degree horizontal pan. Zero forward motion, zero lateral travel. All walls and door frames stay closed and fixed.`;
  const basePrompt = `${CINEMATIC_PROMPT_PREFIX} Morph from opening frame to closing frame inside the same room. ${edge.spatial_relationship || "Stay inside visible geometry."} Keep every wall, doorway, and corner exactly as photographed — rotate the camera in place only, never fly through solid surfaces or open new passages. Shared anchors (${edge.shared_elements.slice(0, 3).join(", ") || "ceiling, floor plane"}) stay fixed.`;

  return {
    ...edge,
    camera_path: cameraPath,
    avoid,
    higgsfield_prompt: finalizeHiggsfieldPrompt(
      basePrompt,
      edge.shared_elements,
      cameraPath,
      avoid,
    ),
  };
}

function transitionVisionPrompt(fromLabel: string, toLabel: string): string {
  const sameRoom = fromLabel === toLabel;
  const roomContext = sameRoom
    ? `Both frames are the SAME room (${fromLabel}) from different camera positions. Do NOT plan a walk into another space.`
    : `Image START is ${fromLabel}. Image END is ${toLabel}. Plan a move only through architecture visible in START.`;

  return `You are a cinematographer planning a seamless image-to-image video morph for a real-estate walkthrough.

${roomContext}

Study both photos carefully:
- Identify shared architecture: floors, walls, windows, furniture, sightlines
- ${sameRoom ? "Choose an in-room orbit, pan, or lateral dolly — the camera never leaves the visible volume and never passes through walls." : "Determine if END is visible from START through a real doorway or hallway already in frame"}
- Never invent doors, windows, hallways, or rooms that are not visible in START

Return JSON only:
{
  "connection_score": 0.0,
  "shared_elements": ["elements visible in both frames"],
  "camera_path": "one sentence describing the exact in-room or through-opening camera move",
  "avoid": ["hallucinated doorways", "walking through walls", "invented rooms"],
  "higgsfield_prompt": "complete prompt for the video model"
}

Rules for higgsfield_prompt:
- Must begin with: "${CINEMATIC_PROMPT_PREFIX}"
- Opening frame must match START exactly; closing frame must match END exactly
- ${sameRoom ? "Describe ONLY a slow orbit, pan, or lateral move inside the same room. Forbidden: forward walk, passing through walls, new doorways, morphing layout." : "Describe ONLY motion through openings already visible in START toward END. If no real opening connects them, use a slow pan/dolly that stays inside START geometry."}
- Never say "walk through a door" unless that exact opening is visible in START
- Explicitly forbid: passing through walls, inventing hallways, adding furniture, morphing walls
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
  model = "gpt-4o-mini",
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
      model,
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
  openAiModel = "gpt-4o-mini",
): Promise<string> {
  const attempts = [
    process.env.GOOGLE_GENERATIVE_AI_API_KEY
      ? () => callGemini(textPrompt, images)
      : null,
    process.env.OPENAI_API_KEY
      ? () => callOpenAI(textPrompt, images, openAiModel)
      : null,
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

function finalizeHiggsfieldPrompt(
  prompt: string,
  sharedElements: string[],
  cameraPath: string,
  avoid: string[],
): string {
  let next = prompt.trim();
  if (!next.startsWith("Photoreal")) {
    next = `${CINEMATIC_PROMPT_PREFIX} ${next}`;
  }
  if (sharedElements.length > 0) {
    next = `${next} Shared anchors: ${sharedElements.slice(0, 4).join(", ")}.`;
  }
  if (cameraPath) {
    next = `${next} ${cameraPath}`;
  }
  if (avoid.length > 0) {
    next = `${next} Avoid: ${avoid.slice(0, 4).join(", ")}.`;
  }
  if (next.length > 900) {
    next = `${next.slice(0, 897)}…`;
  }
  return next;
}

type ParsedWalkthrough = {
  scene_summary: string;
  sequence: number[];
  photos: {
    index: number;
    room_type?: string;
    camera_note?: string;
    anchors?: string[];
    reject?: boolean;
  }[];
  transitions: {
    from_index: number;
    to_index: number;
    connection_score?: number;
    spatial_relationship?: string;
    shared_elements?: string[];
    camera_path?: string;
    can_blend?: boolean;
    avoid?: string[];
    higgsfield_prompt?: string;
  }[];
};

function parseWalkthroughPlan(raw: string, photos: Photo[]): WalkthroughPlan {
  const fallbackSequence = photos.map((_, index) => index);
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("no json");
    const parsed = JSON.parse(match[0]) as ParsedWalkthrough;
    const sequence = Array.isArray(parsed.sequence)
      ? parsed.sequence.filter(
          (index) =>
            Number.isInteger(index) && index >= 0 && index < photos.length,
        )
      : [];
    const unique = [...new Set(sequence)];
    if (unique.length !== photos.length) {
      throw new Error("invalid sequence");
    }

    const photoMeta = new Map(
      (parsed.photos ?? []).map((photo) => [photo.index, photo]),
    );
    const orderedPhotos = unique.map((index) => photos[index]!);
    const transitions: WalkthroughTransitionPlan[] = [];

    for (let i = 0; i < orderedPhotos.length - 1; i += 1) {
      const start = orderedPhotos[i]!;
      const end = orderedPhotos[i + 1]!;
      const startIndex = photos.findIndex((photo) => photo.id === start.id);
      const endIndex = photos.findIndex((photo) => photo.id === end.id);
      const edge =
        parsed.transitions?.find(
          (item) => item.from_index === startIndex && item.to_index === endIndex,
        ) ??
        parsed.transitions?.find(
          (item) =>
            item.from_index === unique[i] && item.to_index === unique[i + 1],
        );
      const shared = Array.isArray(edge?.shared_elements)
        ? edge.shared_elements.map(String)
        : [];
      const avoid = Array.isArray(edge?.avoid)
        ? edge.avoid.map(String)
        : ["invented doorways", "people", "cameras", "moving walls"];
      const cameraPath = edge?.camera_path?.trim() ?? "";
      const fallbackPrompt = transitionPrompt(start.room_type, end.room_type);
      const basePrompt = edge?.higgsfield_prompt?.trim() || fallbackPrompt;
      transitions.push(
        tuneTransitionPrompt(
          {
            from_photo_id: start.id,
            to_photo_id: end.id,
            connection_score: Math.min(
              1,
              Math.max(0, Number(edge?.connection_score) || 0.5),
            ),
            spatial_relationship: edge?.spatial_relationship?.trim() ?? "",
            shared_elements: shared,
            camera_path: cameraPath,
            can_blend: edge?.can_blend !== false,
            avoid,
            higgsfield_prompt: finalizeHiggsfieldPrompt(
              basePrompt,
              shared,
              cameraPath,
              avoid,
            ),
          },
          i,
          start,
          end,
        ),
      );
    }

    return {
      scene_summary: parsed.scene_summary?.trim() ?? "",
      photo_sequence: orderedPhotos.map((photo) => photo.id),
      transitions,
      analyzed_at: new Date().toISOString(),
    };
  } catch (error) {
    console.warn("Walkthrough plan parse failed", error);
    return {
      scene_summary: "",
      photo_sequence: photos.map((photo) => photo.id),
      transitions: [],
      analyzed_at: new Date().toISOString(),
    };
  }
}

export async function planWalkthroughSequence(
  photos: Photo[],
): Promise<WalkthroughPlan> {
  if (photos.length < 2) {
    return {
      scene_summary: "",
      photo_sequence: photos.map((photo) => photo.id),
      transitions: [],
      analyzed_at: new Date().toISOString(),
    };
  }

  if (!hasVisionEnv()) {
    return parseWalkthroughPlan("", photos);
  }

  const images = await Promise.all(
    photos.map(async (photo, index) => ({
      label: `Photo index ${index}${photo.original_filename ? ` (${photo.original_filename})` : ""}:`,
      base64: await imageToJpegBase64(await readPhotoBytes(photo), 768),
    })),
  );

  const raw = await callVision(
    walkthroughPlanPrompt(photos.length),
    images,
    visionPlanningModel(),
  );
  const plan = parseWalkthroughPlan(raw, photos);

  if (plan.transitions.length === 0 && photos.length > 1) {
    const ordered = plan.photo_sequence
      .map((id) => photos.find((photo) => photo.id === id))
      .filter((photo): photo is Photo => Boolean(photo));
    for (let i = 0; i < ordered.length - 1; i += 1) {
      const pair = await planTransitionPair(ordered[i]!, ordered[i + 1]!);
      plan.transitions.push({
        from_photo_id: ordered[i]!.id,
        to_photo_id: ordered[i + 1]!.id,
        connection_score: pair.connection_score,
        spatial_relationship: pair.camera_path,
        shared_elements: pair.shared_elements,
        camera_path: pair.camera_path,
        can_blend: pair.connection_score >= 0.45,
        avoid: ["invented doorways", "people", "cameras", "moving walls"],
        higgsfield_prompt: pair.higgsfield_prompt,
      });
    }
  }

  return plan;
}

export async function rebuildWalkthroughPlanForOrder(
  photos: Photo[],
  existing?: WalkthroughPlan,
): Promise<WalkthroughPlan> {
  const transitions: WalkthroughTransitionPlan[] = [];
  for (let index = 0; index < photos.length - 1; index += 1) {
    const start = photos[index]!;
    const end = photos[index + 1]!;
    const existingEdge = existing?.transitions.find(
      (item) =>
        item.from_photo_id === start.id && item.to_photo_id === end.id,
    );
    if (existingEdge) {
      transitions.push(existingEdge);
      continue;
    }
    const pair = await planTransitionPair(start, end);
    transitions.push(
      tuneTransitionPrompt(
        {
          from_photo_id: start.id,
          to_photo_id: end.id,
          connection_score: pair.connection_score,
          spatial_relationship: pair.camera_path,
          shared_elements: pair.shared_elements,
          camera_path: pair.camera_path,
          can_blend: pair.connection_score >= 0.45,
          avoid: ["invented doorways", "people", "cameras", "moving walls"],
          higgsfield_prompt: pair.higgsfield_prompt,
        },
        index,
        start,
        end,
      ),
    );
  }

  return {
    scene_summary: existing?.scene_summary ?? "",
    photo_sequence: photos.map((photo) => photo.id),
    transitions,
    analyzed_at: new Date().toISOString(),
  };
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
  plan.higgsfield_prompt = finalizeHiggsfieldPrompt(
    plan.higgsfield_prompt,
    plan.shared_elements,
    plan.camera_path,
    ["invented doorways", "people", "cameras", "moving walls"],
  );
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

  const edge = record.walkthrough_plan?.transitions.find(
    (item) =>
      item.from_photo_id === clip.photo_id &&
      item.to_photo_id === clip.end_photo_id,
  );
  const prompt = edge
    ? tuneTransitionPrompt(edge, clip.sort_order, start, end).higgsfield_prompt
    : (await planTransitionPair(start, end)).higgsfield_prompt;

  await mutateTour(tourId, (current) => {
    const target = current.clips.find((item) => item.id === clipId);
    if (!target) return;
    target.prompt = prompt;
    target.updated_at = new Date().toISOString();
    const planEdge = current.walkthrough_plan?.transitions.find(
      (item) =>
        item.from_photo_id === clip.photo_id &&
        item.to_photo_id === clip.end_photo_id,
    );
    if (planEdge) {
      planEdge.higgsfield_prompt = prompt;
      planEdge.camera_path = tuneTransitionPrompt(
        planEdge,
        clip.sort_order,
        start,
        end,
      ).camera_path;
    }
  });
  return prompt;
}

export async function enrichTransitionPrompts(tourId: string): Promise<void> {
  const record = await readTourRecord(tourId);
  const transitionClips = record.clips.filter((clip) => clip.end_photo_id);
  if (transitionClips.length === 0) return;

  if (record.walkthrough_plan?.transitions.length) {
    await mutateTour(tourId, (current) => {
      for (const clip of current.clips) {
        if (!clip.end_photo_id || !clip.photo_id) continue;
        const edge = current.walkthrough_plan?.transitions.find(
          (item) =>
            item.from_photo_id === clip.photo_id &&
            item.to_photo_id === clip.end_photo_id,
        );
        if (edge && clip.photo_id && clip.end_photo_id) {
          const start = current.photos.find(
            (photo) => photo.id === clip.photo_id,
          );
          const end = current.photos.find(
            (photo) => photo.id === clip.end_photo_id,
          );
          if (start && end) {
            const tuned = tuneTransitionPrompt(
              edge,
              clip.sort_order,
              start,
              end,
            );
            clip.prompt = tuned.higgsfield_prompt;
            edge.higgsfield_prompt = tuned.higgsfield_prompt;
            edge.camera_path = tuned.camera_path;
            edge.avoid = tuned.avoid;
          }
          clip.updated_at = new Date().toISOString();
        }
      }
    });
    return;
  }

  if (!hasVisionEnv()) return;

  await mutateTour(tourId, (current) => {
    current.tour.progress_label = `Analyzing ${transitionClips.length} photo connection${transitionClips.length === 1 ? "" : "s"}…`;
    current.tour.updated_at = new Date().toISOString();
  });

  for (const clip of transitionClips) {
    await enrichClipPrompt(tourId, clip.id);
  }
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
    const rejected = Boolean(tag?.reject) || roomType === "floorplan";
    const rejectReason =
      tag?.reject_reason ?? (roomType === "floorplan" ? "floorplan" : null);

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

  await mutateTour(tourId, async (record) => {
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
      return a.sort_order - b.sort_order;
    });
    record.photos.forEach((photo, index) => {
      photo.sort_order = index;
    });

    const included = record.photos.filter((photo) => !photo.rejected);
    if (included.length >= 2 && hasVisionEnv()) {
      record.tour.progress_label = "Mapping layout and sequencing photos…";
      const uploadOrdered = [...included].sort(
        (a, b) => a.sort_order - b.sort_order,
      );
      const sameRoomMulti =
        uploadOrdered.length >= 3 &&
        uploadOrdered.every(
          (photo) => photo.room_type === uploadOrdered[0]!.room_type,
        );
      const initialPlan = await planWalkthroughSequence(uploadOrdered);
      const sequenced = sameRoomMulti
        ? orderSameRoomWalkPhotos(uploadOrdered)
        : initialPlan.photo_sequence
            .map((id) => uploadOrdered.find((photo) => photo.id === id))
            .filter((photo): photo is Photo => Boolean(photo));
      const plan = sameRoomMulti
        ? await rebuildWalkthroughPlanForOrder(sequenced, initialPlan)
        : initialPlan;
      const rejected = record.photos.filter((photo) => photo.rejected);
      record.photos = [...sequenced, ...rejected];
      record.photos.forEach((photo, index) => {
        photo.sort_order = index;
      });
      record.walkthrough_plan = plan;
      record.tour.progress_label = plan.scene_summary
        ? `Walkthrough mapped: ${plan.scene_summary}`
        : "Walkthrough sequence planned. Review order, then generate.";
    } else {
      record.tour.progress_label = hasVisionEnv()
        ? "Rooms tagged with vision. Reorder if needed, then generate."
        : "Rooms tagged. Reorder if needed, then generate.";
    }

    record.tour.status = "ready";
    record.tour.error = null;
  });
}
