import { CINEMATIC_PROMPT_PREFIX } from "./rooms";

const WALL_LINE =
  "Never pass through walls, closed doors, windows, or furniture, and do not invent rooms or openings.";

export function complaintConstraints(note: string): string[] {
  const text = note.toLowerCase();
  const extra: string[] = [];
  if (/wall|door|clip|through|geometry|melt/.test(text)) {
    extra.push(
      "passing through walls",
      "opening closed doors",
      "melting architecture",
    );
  }
  if (/jump|cut|teleport|sequence|order|blend/.test(text)) {
    extra.push("jump cuts", "teleporting", "hard cuts between photos");
  }
  if (/fast|slow|speed|rush/.test(text)) {
    extra.push("rushed camera moves");
  }
  if (/invent|fake|new room|hallway|space/.test(text)) {
    extra.push("invented spaces");
  }
  if (/drone|fly|float|walk/.test(text)) {
    extra.push("locked tripod shots");
  }
  return extra;
}

/** One clean drone-blend prompt. Guardrails are always present, even after a user note. */
export function composeDroneBlendPrompt(input: {
  spatial?: string;
  shared?: string[];
  cameraPath?: string;
  avoid?: string[];
  revision?: string | null;
}): string {
  const shared = (input.shared ?? []).map((item) => item.trim()).filter(Boolean).slice(0, 3);
  const avoid = [
    ...new Set([
      ...(input.avoid ?? []),
      ...complaintConstraints(input.revision ?? ""),
      "passing through walls",
      "invented rooms",
      "people",
    ]),
  ].slice(0, 6);

  const correctionText = input.revision?.trim().replace(/[.\s]+$/g, "");
  const correction = correctionText
    ? `Director correction: ${correctionText}. Keep the same opening and closing photos.`
    : "";
  const locked = [WALL_LINE, correction].filter(Boolean).join(" ");
  const head = [
    CINEMATIC_PROMPT_PREFIX,
    "One continuous interior drone blend from the opening photo to the closing photo, then hold on the closing photo.",
    input.spatial?.trim() ||
      "Glide only through open floor space that is already visible in the opening photo.",
    input.cameraPath?.trim() ||
      "Slow chest-height gimbal float with a gentle arc. No teleport and no jump cut.",
    shared.length ? `Fixed anchors: ${shared.join(", ")}.` : "",
    avoid.length ? `Do not: ${avoid.join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const budget = Math.max(80, 700 - locked.length - 1);
  const fitted = head.length > budget ? `${head.slice(0, budget - 1).trimEnd()}…` : head;
  return `${fitted} ${locked}`.trim();
}

export function promptKeepsWalkthroughGuardrails(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return (
    text.includes("never pass through walls") &&
    text.includes("opening photo") &&
    text.includes("closing photo") &&
    text.includes("drone")
  );
}
