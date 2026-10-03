function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export function getHiggsfieldCredentials(): {
  keyId: string;
  keySecret: string;
} {
  const combined = process.env.HF_CREDENTIALS;
  if (combined?.includes(":")) {
    const [keyId, ...rest] = combined.split(":");
    return { keyId, keySecret: rest.join(":") };
  }
  return {
    keyId: required("HF_API_KEY_ID", process.env.HF_API_KEY_ID),
    keySecret: required("HF_API_KEY_SECRET", process.env.HF_API_KEY_SECRET),
  };
}

export function hasHiggsfieldEnv(): boolean {
  return Boolean(
    process.env.HF_CREDENTIALS ||
      (process.env.HF_API_KEY_ID && process.env.HF_API_KEY_SECRET),
  );
}

export function videoModel(): string {
  return (
    process.env.HF_VIDEO_MODEL ?? "kling-video/v2.1/pro/image-to-video"
  );
}

export function heroModel(): string {
  return process.env.HF_HERO_MODEL ?? transitionModel();
}

export function visionPlanningModel(): string {
  return process.env.OPENAI_VISION_MODEL ?? "gpt-4o";
}

export function transitionModel(): string {
  return (
    process.env.HF_TRANSITION_MODEL ?? "higgsfield-ai/dop/turbo"
  );
}

export function videoFallbackModel(): string {
  return process.env.HF_VIDEO_FALLBACK_MODEL ?? "higgsfield-ai/dop/turbo";
}

export function clipDurationSeconds(): number {
  const parsed = Number(process.env.HF_CLIP_DURATION ?? "4");
  if (!Number.isFinite(parsed)) return 4;
  return Math.min(10, Math.max(3, Math.round(parsed)));
}

export function generationConcurrency(): number {
  const parsed = Number(process.env.HF_GENERATION_CONCURRENCY ?? "2");
  if (!Number.isFinite(parsed)) return 2;
  return Math.min(4, Math.max(1, Math.round(parsed)));
}

export function higgsfieldEnhancePrompt(): boolean {
  return process.env.HF_ENHANCE_PROMPT === "true";
}

export function videoResolution(): string {
  return process.env.HF_RESOLUTION ?? "720p";
}

export function pipelineDriver(): "inline" | "inngest" {
  return process.env.PIPELINE_DRIVER === "inngest" ? "inngest" : "inline";
}
