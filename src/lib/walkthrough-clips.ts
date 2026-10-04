import type { WalkthroughTransitionPlan } from "./store";
import type { Photo } from "./types";
import type { ViewAngleRole } from "./rooms";

export type PhotoViewMeta = {
  photo_id: string;
  view_angle: ViewAngleRole;
};

/** Wide jumps between these angles must not use HF morph (causes wall clipping). */
const NON_MORPHABLE_PAIRS = new Set<string>([
  "corner->entrance_overview",
  "corner->left_view",
  "corner->other",
  "entrance_overview->corner",
  "left_view->corner",
  "left_view->entrance_overview",
]);

export function viewRoleForPhoto(
  photoId: string,
  views: PhotoViewMeta[] | undefined,
): ViewAngleRole {
  return views?.find((item) => item.photo_id === photoId)?.view_angle ?? "other";
}

export function shouldMorphEdge(
  startRole: ViewAngleRole,
  endRole: ViewAngleRole,
  edge?: WalkthroughTransitionPlan,
): boolean {
  const pairKey = `${startRole}->${endRole}`;
  if (NON_MORPHABLE_PAIRS.has(pairKey)) return false;
  if (!edge?.can_blend) return false;
  if (edge.connection_score < 0.75) return false;
  if (edge.shared_elements.length < 2) return false;
  // Only morph adjacent layout views that share a sightline (overview → left).
  return (
    (startRole === "entrance_overview" && endRole === "left_view") ||
    (startRole === "left_view" && endRole === "entrance_overview")
  );
}

export function holdSecondsForRole(role: ViewAngleRole, isFirst: boolean): number {
  if (isFirst || role === "corner") return 4;
  if (role === "entrance_overview") return 2.5;
  return 2.5;
}

export type PlannedSegment =
  | { kind: "hold"; photo: Photo; seconds: number }
  | {
      kind: "morph";
      start: Photo;
      end: Photo;
      prompt: string;
      edge?: WalkthroughTransitionPlan;
    };

export function planSameRoomSegments(
  ordered: Photo[],
  views: PhotoViewMeta[] | undefined,
  transitions: WalkthroughTransitionPlan[],
): PlannedSegment[] {
  const segments: PlannedSegment[] = [];
  const n = ordered.length;

  for (let index = 0; index < n - 1; index += 1) {
    const start = ordered[index]!;
    const end = ordered[index + 1]!;
    const startRole = viewRoleForPhoto(start.id, views);
    const endRole = viewRoleForPhoto(end.id, views);
    const edge = transitions.find(
      (item) =>
        item.from_photo_id === start.id && item.to_photo_id === end.id,
    );
    const morph = shouldMorphEdge(startRole, endRole, edge);

    if (morph && index === n - 2) {
      const lastSegment = segments.at(-1);
      const needsSettleHold =
        !lastSegment ||
        (lastSegment.kind === "hold" && lastSegment.photo.id !== start.id) ||
        lastSegment.kind === "morph";

      if (needsSettleHold) {
        segments.push({
          kind: "hold",
          photo: start,
          seconds: holdSecondsForRole(startRole, false),
        });
      }

      segments.push({
        kind: "morph",
        start,
        end,
        prompt:
          edge?.higgsfield_prompt ??
          "Photoreal cinematic interior drone flyby morph along visible open floor space.",
        edge,
      });
    } else {
      segments.push({
        kind: "hold",
        photo: start,
        seconds: holdSecondsForRole(startRole, index === 0),
      });
    }
  }

  return segments;
}
