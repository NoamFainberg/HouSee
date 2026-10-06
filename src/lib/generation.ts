export const STALE_GENERATION_MS = 20 * 60 * 1000;

export function isGenerationStale(updatedAt: string): boolean {
  return Date.now() - new Date(updatedAt).getTime() > STALE_GENERATION_MS;
}
