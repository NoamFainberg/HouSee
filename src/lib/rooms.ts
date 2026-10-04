import type { Photo, RoomType } from "./types";

export const WALKTHROUGH_ORDER: RoomType[] = [
  "exterior",
  "entry",
  "living",
  "dining",
  "kitchen",
  "bedroom",
  "bathroom",
  "balcony",
  "view",
  "amenity",
  "other",
  "floorplan",
];

export const ROOM_LABELS: Record<RoomType, string> = {
  exterior: "Exterior",
  entry: "Entry",
  living: "Living room",
  dining: "Dining",
  kitchen: "Kitchen",
  bedroom: "Bedroom",
  bathroom: "Bathroom",
  balcony: "Balcony",
  view: "View",
  amenity: "Amenity",
  other: "Other",
  floorplan: "Floor plan",
};

const CINEMATIC =
  "Photoreal cinematic real-estate walkthrough, 24mm gimbal, natural light, locked architecture, no people, no morphing walls, no extra furniture, no text overlay, no walking figures, no new doorways, no disappearing walls, geometry stays fixed.";

export const CINEMATIC_PROMPT_PREFIX = CINEMATIC;

export type CameraPreset = {
  move: string;
  prompt: string;
};

export const CAMERA_PRESETS: Record<RoomType, CameraPreset> = {
  exterior: {
    move: "crane_dolly_in",
    prompt: `${CINEMATIC} Slow crane down then a gentle dolly toward the entrance, like arriving at the property.`,
  },
  entry: {
    move: "dolly_forward",
    prompt: `${CINEMATIC} Slow steadicam dolly forward through the entry as if walking inside.`,
  },
  living: {
    move: "micro_pan",
    prompt: `${CINEMATIC} Nearly static tripod shot with an imperceptible 5-degree pan across the living room. All walls, doors, windows, and furniture remain exactly as photographed.`,
  },
  dining: {
    move: "dolly_across",
    prompt: `${CINEMATIC} Smooth lateral dolly across the dining table, then a slight push in.`,
  },
  kitchen: {
    move: "island_orbit",
    prompt: `${CINEMATIC} Slow orbit around the kitchen island, then a gentle push toward the counters. Keep cabinetry straight.`,
  },
  bedroom: {
    move: "slow_push",
    prompt: `${CINEMATIC} Slow push toward the bed and windows, calm and intimate, stable geometry.`,
  },
  bathroom: {
    move: "reveal_push",
    prompt: `${CINEMATIC} Gentle push into the bathroom, revealing vanity and shower. Keep tile lines straight.`,
  },
  balcony: {
    move: "window_approach",
    prompt: `${CINEMATIC} Slow move toward the balcony doors, then a slight crane up to the view.`,
  },
  view: {
    move: "window_reveal",
    prompt: `${CINEMATIC} Slow push toward the window, then a gentle pan across the view.`,
  },
  amenity: {
    move: "hero_orbit",
    prompt: `${CINEMATIC} Slow cinematic orbit of the amenity space, premium real-estate commercial.`,
  },
  other: {
    move: "slow_push",
    prompt: `${CINEMATIC} Slow cinematic push into the space with a subtle pan.`,
  },
  floorplan: {
    move: "static",
    prompt: `${CINEMATIC} Hold a slow, almost static push on the image.`,
  },
};

export function walkthroughRank(room: RoomType): number {
  const index = WALKTHROUGH_ORDER.indexOf(room);
  return index === -1 ? WALKTHROUGH_ORDER.length : index;
}

export function isRoomType(value: string): value is RoomType {
  return (WALKTHROUGH_ORDER as string[]).includes(value);
}

export type SameRoomViewRole = "establish" | "feature" | "detail";

export function inferSameRoomViewRole(filename: string): SameRoomViewRole | null {
  const n = filename.toLowerCase();
  if (/tv|01-living|establish|hero|wide/.test(n)) return "establish";
  if (/window|02-living|curtain|drape/.test(n)) return "feature";
  if (/seating|sofa|03-living|lounge/.test(n)) return "detail";
  return null;
}

export function orderSameRoomWalkPhotos(photos: Photo[]): Photo[] {
  if (photos.length < 3) return photos;
  const roles = photos.map((photo) => ({
    photo,
    role: inferSameRoomViewRole(photo.original_filename ?? ""),
  }));
  const establish = roles.find((item) => item.role === "establish");
  const feature = roles.find((item) => item.role === "feature");
  const detail = roles.find((item) => item.role === "detail");
  if (establish && feature && detail) {
    return [establish.photo, feature.photo, detail.photo];
  }
  return [...photos].sort((a, b) => a.sort_order - b.sort_order);
}

export function inferRoomFromFilename(filename: string): RoomType {
  const n = filename.toLowerCase();
  if (/floor.?plan|layout|blueprint|plattegrond/.test(n)) return "floorplan";
  if (/kitchen|kuche|koch|cuisine/.test(n)) return "kitchen";
  if (/living|salon|lounge|wohn/.test(n)) return "living";
  if (/dining|essen/.test(n)) return "dining";
  if (/bed|schlaf|chamber/.test(n)) return "bedroom";
  if (/bath|bad|wc|toilet/.test(n)) return "bathroom";
  if (/balcon|terrace|patio|deck/.test(n)) return "balcony";
  if (/exterior|facade|outside|front|building|street/.test(n)) return "exterior";
  if (/entry|foyer|hall|entrance/.test(n)) return "entry";
  if (/view|skyline|window/.test(n)) return "view";
  if (/pool|gym|amenit|garden|yard/.test(n)) return "amenity";
  return "other";
}

export function sameRoomAnglePrompt(room: RoomType): string {
  const label = ROOM_LABELS[room].toLowerCase();
  return `${CINEMATIC} Hold inside the ${label} shown in the photo. Slow cinematic orbit or gentle lateral pan only — no forward walk, no passing through walls, no invented doorways or new rooms. Walls, ceiling, and furniture stay fixed; only the camera moves within the visible space.`;
}

export function transitionPrompt(from: RoomType, to: RoomType): string {
  if (from === to) {
    return sameRoomAnglePrompt(from);
  }
  const fromLabel = ROOM_LABELS[from].toLowerCase();
  const toLabel = ROOM_LABELS[to].toLowerCase();
  return `${CINEMATIC} One continuous steadicam move from the ${fromLabel} into the ${toLabel}. Opening frame matches the first photo exactly; closing frame matches the second photo exactly. Use only doorways, hallways, or sightlines visible in the opening frame — never pass through solid walls or invent new openings. No people, stable architecture, no morphing geometry.`;
}

export function clipLabel(from: RoomType, to?: RoomType): string {
  if (!to) return ROOM_LABELS[from];
  return `${ROOM_LABELS[from]} → ${ROOM_LABELS[to]}`;
}
