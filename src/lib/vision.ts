import sharp from "sharp";
import {
  CINEMATIC_PROMPT_PREFIX,
  inferRoomFromFilename,
  inferSameRoomViewRole,
  isRoomType,
  orderPhotosByViewAngles,
  ROOM_LABELS,
  transitionPrompt,
  VIEW_ANGLE_WALK_ORDER,
  type ViewAngleRole,
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
  return `You are a cinematographer planning a seamless interior DRONE FLYBY tour — a smooth gimbal float through a living room, never teleporting.

You receive ${photoCount} photographs of the same room from different positions. Study ALL images together before deciding anything.

Your tasks:
1. Classify each photo: corner (salon corner near door/wall), entrance_overview (wide layout from entrance), left_view (room seen from the left toward seating/window)
2. Order photos for the flyby: corner FIRST → entrance_overview SECOND → left_view THIRD (adjust if fewer angles)
3. For every consecutive pair, list shared_elements visible in BOTH frames (lock geometry during morph and stitch seams)
4. Write Higgsfield morph prompts: smooth drone glide along open floor space; clip N lands on photo N+1 for a seamless cut

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
- sequence[0] = corner/salon angle; sequence[1] = entrance overview (widest layout); sequence[2] = left-side view — NEVER reverse this narrative
- sequence must list every non-rejected photo index exactly once (${photoCount} indices total, 0-based)
- can_blend=true ONLY when shared_elements are genuinely visible in BOTH frames and a drone could glide between them without clipping walls
- higgsfield_prompt MUST begin with: "${CINEMATIC_PROMPT_PREFIX}"
- Opening frame must match from_index exactly; closing frame must match to_index exactly and HOLD on it
- Describe a smooth drone gimbal glide along visible open floor space — gentle arc, chest height, NOT a locked tripod pan
- NEVER pass through solid walls, doors, or furniture; name walls/door frames in START that must stay closed
- If two views cannot connect without clipping geometry, set can_blend=false
- Keep each higgsfield_prompt under 420 characters
- room_type must be one of: exterior, entry, living, kitchen, dining, bedroom, bathroom, balcony, view, amenity, other, floorplan`;
}

const WALL_SAFE_AVOID = [
  "passing through walls",
  "clip through geometry",
  "moving walls",
  "invented doorways",
  "flying through doors",
  "people",
  "cameras",
  "equipment",
];

function classifyViewAnglesPrompt(count: number): string {
  return `Classify ${count} living-room photos for a drone flyby tour.

For each image index (0-based) assign view_angle:
- corner: salon corner near door/wall junction, intimate partial view
- entrance_overview: wide overview from entrance showing most of the room layout (often deeper/wider perspective)
- left_view: camera on the left side of the room looking toward seating/window area
- other: none of the above

Return JSON only:
{"photos":[{"index":0,"view_angle":"corner","summary":"one line"}]}

Tour playback order is always: corner → entrance_overview → left_view → other.`;
}

const CONSERVATIVE_MORPH_AVOID = [
  ...WALL_SAFE_AVOID,
  "opening doors",
  "walking through doorways",
  "flying doors",
  "shortcut through furniture",
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
    (!edge.can_blend ||
      edge.connection_score < 0.7 ||
      establishToNext ||
      (degrees !== null && degrees > 45));

  const avoid = [...new Set([...edge.avoid, ...WALL_SAFE_AVOID])];
  const dronePath =
    "Smooth interior drone gimbal glide at chest height along visible open floor space — gentle forward arc, slow float. All walls, door frames, and ceiling edges stay solid; never clip through surfaces.";

  if (!needsConservative) {
    return {
      ...edge,
      avoid,
      camera_path: edge.camera_path || dronePath,
      higgsfield_prompt: finalizeHiggsfieldPrompt(
        edge.higgsfield_prompt,
        edge.shared_elements,
        edge.camera_path || dronePath,
        avoid,
      ),
    };
  }

  const cameraPath = `${dronePath} Stay inside the visible room volume — no shortcuts through walls or closed doors.`;
  const basePrompt = `${CINEMATIC_PROMPT_PREFIX} Drone flyby morph inside the same room. ${edge.spatial_relationship || "Glide along open floor space."} ${edge.shared_elements.slice(0, 3).join(", ") || "Floor plane and walls"} remain fixed anchors — never clip through solid walls or furniture.`;

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

  return `You are a cinematographer planning a seamless drone flyby morph between two frames.

${roomContext}

Study both photos carefully:
- Identify shared architecture: floors, walls, windows, furniture, sightlines
- Plan a smooth interior drone gimbal glide along visible open floor space — chest height, gentle arc
- The drone NEVER clips through walls, doors, or furniture; never invent openings

Return JSON only:
{
  "connection_score": 0.0,
  "shared_elements": ["elements visible in both frames"],
  "camera_path": "one sentence describing the drone glide path along open floor space",
  "avoid": ["passing through walls", "clip through geometry", "invented doorways"],
  "higgsfield_prompt": "complete prompt for the video model"
}

Rules for higgsfield_prompt:
- Must begin with: "${CINEMATIC_PROMPT_PREFIX}"
- Opening frame must match START exactly; closing frame must match END exactly
- ${sameRoom ? "Describe a smooth drone gimbal float along open floor space inside the room. Forbidden: clipping through walls, moving walls, new doorways." : "Glide through openings already visible in START toward END only."}
- Name shared anchors and solid walls that must stay fixed
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
  next = `${next} End by holding the closing frame on shared anchors for a seamless cut to the next shot.`;
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

export function sameRoomSet(photos: Photo[]): boolean {
  return (
    photos.length >= 3 &&
    photos.every((photo) => photo.room_type === photos[0]!.room_type)
  );
}

function photoViewsFromRoles(
  ordered: Photo[],
  uploadOrdered: Photo[],
  viewRoles: ViewAngleRole[],
): WalkthroughPlan["photo_views"] {
  return ordered.map((photo) => {
    const uploadIndex = uploadOrdered.findIndex((item) => item.id === photo.id);
    return {
      photo_id: photo.id,
      view_angle: viewRoles[uploadIndex] ?? "other",
    };
  });
}

function parseViewAngleRoles(
  raw: string,
  count: number,
): ViewAngleRole[] {
  const fallback = Array<ViewAngleRole>(count).fill("other");
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return fallback;
    const parsed = JSON.parse(match[0]) as {
      photos?: { index?: number; view_angle?: string }[];
    };
    const roles = [...fallback];
    for (const item of parsed.photos ?? []) {
      const index = Number(item.index);
      const angle = item.view_angle;
      if (
        Number.isInteger(index) &&
        index >= 0 &&
        index < count &&
        VIEW_ANGLE_WALK_ORDER.includes(angle as ViewAngleRole)
      ) {
        roles[index] = angle as ViewAngleRole;
      }
    }
    return roles;
  } catch {
    return fallback;
  }
}

async function classifySameRoomViewAngles(
  photos: Photo[],
): Promise<ViewAngleRole[]> {
  if (!hasVisionEnv() || photos.length === 0) {
    return photos.map(() => "other" as ViewAngleRole);
  }

  const images = await Promise.all(
    photos.map(async (photo, index) => ({
      label: `Photo index ${index}${photo.original_filename ? ` (${photo.original_filename})` : ""}:`,
      base64: await imageToJpegBase64(await readPhotoBytes(photo), 768),
    })),
  );

  try {
    const raw = await callVision(
      classifyViewAnglesPrompt(photos.length),
      images,
      visionPlanningModel(),
    );
    return parseViewAngleRoles(raw, photos.length);
  } catch (error) {
    console.warn("View angle classification failed", error);
    return photos.map(() => "other" as ViewAngleRole);
  }
}

/** Order same-room photos: salon corner → entrance overview → left view. */
async function refineSameRoomWalkOrder(
  photos: Photo[],
  plan: WalkthroughPlan,
): Promise<{ ordered: Photo[]; plan: WalkthroughPlan }> {
  const byId = new Map(photos.map((photo) => [photo.id, photo]));

  if (!sameRoomSet(photos)) {
    const ordered = plan.photo_sequence
      .map((id) => byId.get(id))
      .filter((photo): photo is Photo => Boolean(photo));
    return {
      ordered: ordered.length === photos.length ? ordered : photos,
      plan,
    };
  }

  const uploadOrdered = [...photos].sort((a, b) => a.sort_order - b.sort_order);
  const viewRoles = await classifySameRoomViewAngles(uploadOrdered);
  const ordered = orderPhotosByViewAngles(uploadOrdered, viewRoles);

  const photo_views = photoViewsFromRoles(ordered, uploadOrdered, viewRoles);
  const orderChanged = ordered.some(
    (photo, index) => photo.id !== plan.photo_sequence[index],
  );
  if (!orderChanged) {
    return { ordered, plan: { ...plan, photo_views } };
  }

  const rebuilt = await rebuildWalkthroughPlanForOrder(ordered, plan);
  return {
    ordered,
    plan: { ...rebuilt, photo_views },
  };
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
    photo_views: existing?.photo_views,
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
      const initialPlan = await planWalkthroughSequence(uploadOrdered);
      const { ordered: sequenced, plan } = await refineSameRoomWalkOrder(
        uploadOrdered,
        initialPlan,
      );
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
