import {
  clipDurationSeconds,
  getHiggsfieldCredentials,
  heroModel,
  higgsfieldEnhancePrompt,
  transitionModel,
  videoFallbackModel,
  videoModel,
} from "./env";

const PLATFORM = "https://platform.higgsfield.ai";
const POLL_INTERVAL_MS = 2000;
const MAX_POLL_MS = 12 * 60 * 1000;

export type GenerateArgs = {
  prompt: string;
  startImageUrl: string;
  endImageUrl?: string;
};

export type SubmitResult = {
  requestId: string;
  model: string;
};

export type GenerateResult = SubmitResult & {
  videoUrl: string;
};

type PollOptions = {
  onStatus?: (status: string, elapsedMs: number) => void | Promise<void>;
};

function authHeader() {
  const { keyId, keySecret } = getHiggsfieldCredentials();
  return `Key ${keyId}:${keySecret}`;
}

export async function uploadToHiggsfield(
  bytes: Buffer,
  contentType: string,
): Promise<string> {
  const uploadRes = await fetch(`${PLATFORM}/files/generate-upload-url`, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content_type: contentType }),
  });
  if (!uploadRes.ok) {
    throw new Error(
      `Higgsfield upload URL failed (${uploadRes.status}): ${await uploadRes.text()}`,
    );
  }
  const payload = (await uploadRes.json()) as {
    public_url: string;
    upload_url: string;
    upload_headers?: Record<string, string>;
  };
  const put = await fetch(payload.upload_url, {
    method: "PUT",
    headers: payload.upload_headers ?? { "Content-Type": contentType },
    body: new Uint8Array(bytes),
  });
  if (!put.ok) {
    throw new Error(
      `Higgsfield file upload failed (${put.status}): ${await put.text()}`,
    );
  }
  return payload.public_url;
}

function supportsEndFrame(model: string): boolean {
  return (
    model.includes("dop") ||
    model.includes("image2video/dop") ||
    model.includes("hailuo")
  );
}

function inputForModel(
  model: string,
  args: GenerateArgs,
): Record<string, unknown> {
  const duration = clipDurationSeconds();

  if (model.includes("dop") || model.includes("image2video/dop")) {
    const input: Record<string, unknown> = {
      prompt: args.prompt,
      image_url: args.startImageUrl,
      enhance_prompt: higgsfieldEnhancePrompt(),
    };
    if (args.endImageUrl) {
      input.end_image_url = args.endImageUrl;
    }
    return input;
  }

  if (model.includes("hailuo")) {
    const input: Record<string, unknown> = {
      prompt: args.prompt,
      image_url: args.startImageUrl,
    };
    if (args.endImageUrl) {
      input.end_image_url = args.endImageUrl;
    }
    return input;
  }

  if (model.includes("kling-video")) {
    return {
      prompt: args.prompt,
      image_url: args.startImageUrl,
      duration,
    };
  }

  const input: Record<string, unknown> = {
    prompt: args.prompt,
    image_url: args.startImageUrl,
    duration,
  };
  if (args.endImageUrl && supportsEndFrame(model)) {
    input.end_image_url = args.endImageUrl;
  }
  return input;
}

function extractVideoUrl(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const video = record.video;
  if (video && typeof video === "object" && "url" in video) {
    const url = (video as { url?: unknown }).url;
    if (typeof url === "string") return url;
  }
  const images = record.images;
  if (Array.isArray(images) && images[0]?.url) return String(images[0].url);
  const jobs = record.jobs as
    | { results?: { raw?: { url?: string } } }[]
    | undefined;
  const jobUrl = jobs?.[0]?.results?.raw?.url;
  if (jobUrl) return jobUrl;
  return null;
}

export function modelForArgs(args: GenerateArgs): string {
  return args.endImageUrl ? transitionModel() : heroModel();
}

export async function submitGeneration(
  model: string,
  args: GenerateArgs,
): Promise<SubmitResult> {
  const response = await fetch(`${PLATFORM}/${model.replace(/^\//, "")}`, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(inputForModel(model, args)),
  });
  if (!response.ok) {
    throw new Error(
      `Higgsfield submit failed (${response.status}) on ${model}: ${await response.text()}`,
    );
  }
  const json = (await response.json()) as { request_id?: string };
  if (!json.request_id) {
    throw new Error("Higgsfield did not return a request_id");
  }
  return { requestId: json.request_id, model };
}

export async function checkGeneration(requestId: string): Promise<{
  status: string;
  videoUrl: string | null;
}> {
  const statusRes = await fetch(`${PLATFORM}/requests/${requestId}/status`, {
    headers: { Authorization: authHeader() },
  });
  if (!statusRes.ok) {
    throw new Error(
      `Higgsfield status failed (${statusRes.status}): ${await statusRes.text()}`,
    );
  }
  const json = await statusRes.json();
  const status = (json.status as string | undefined) ?? "unknown";
  if (status === "failed" || status === "nsfw" || status === "canceled") {
    throw new Error(`Higgsfield generation ${status}`);
  }
  if (status === "completed") {
    const videoUrl = extractVideoUrl(json);
    if (!videoUrl) throw new Error("Higgsfield completed without a video URL");
    return { status, videoUrl };
  }
  return { status, videoUrl: null };
}

export async function pollGeneration(
  requestId: string,
  options: PollOptions = {},
): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < MAX_POLL_MS) {
    const checked = await checkGeneration(requestId);
    await options.onStatus?.(checked.status, Date.now() - started);
    if (checked.videoUrl) return checked.videoUrl;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error("Higgsfield generation timed out after 12 minutes");
}

export async function submitWalkthroughGeneration(
  args: GenerateArgs,
): Promise<SubmitResult> {
  if (args.endImageUrl) {
    return submitGeneration(transitionModel(), args);
  }

  const primary = heroModel();
  try {
    return await submitGeneration(primary, args);
  } catch (primaryError) {
    const fallback = videoFallbackModel();
    if (fallback === primary) {
      const legacy = videoModel();
      if (legacy === primary) throw primaryError;
      return submitGeneration(legacy, args);
    }
    return submitGeneration(fallback, {
      prompt: args.prompt,
      startImageUrl: args.startImageUrl,
    });
  }
}

export async function generateWalkthroughClip(
  args: GenerateArgs,
): Promise<GenerateResult> {
  const submitted = await submitWalkthroughGeneration(args);
  const videoUrl = await pollGeneration(submitted.requestId);
  return { ...submitted, videoUrl };
}

export async function downloadBinary(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}
