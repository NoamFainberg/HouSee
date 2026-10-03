export const STALE_GENERATION_MS = 90_000;

export function isGenerationStale(updatedAt: string): boolean {
  return Date.now() - new Date(updatedAt).getTime() > STALE_GENERATION_MS;
}
