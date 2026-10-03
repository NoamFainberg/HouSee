"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Download, RefreshCw } from "lucide-react";
import { clipLabel, ROOM_LABELS, WALKTHROUGH_ORDER } from "@/lib/rooms";
import { isGenerationStale } from "@/lib/generation";
import type { RoomType, TourDetail } from "@/lib/types";

const ACTIVE = new Set(["generating", "stitching", "curating"]);

export function TourStudio({
  tourId,
  initial,
}: {
  tourId: string;
  initial: TourDetail | null;
}) {
  const [detail, setDetail] = useState<TourDetail | null>(initial);
  const [error, setError] = useState<string | null>(
    initial ? null : "Tour not found",
  );
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/tours/${tourId}`, { cache: "no-store" });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error || "Could not load tour");
    setDetail(json);
  }, [tourId]);

  useEffect(() => {
    if (!detail || !ACTIVE.has(detail.tour.status)) return;
    const timer = setInterval(() => {
      void refresh().catch(() => undefined);
    }, 2500);
    return () => clearInterval(timer);
  }, [detail, refresh]);

  async function savePhotos() {
    if (!detail) return;
    const response = await fetch(`/api/tours/${tourId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        photos: detail.photos.map((photo) => ({
          id: photo.id,
          room_type: photo.room_type,
          rejected: photo.rejected,
          sort_order: photo.sort_order,
        })),
      }),
    });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error || "Save failed");
    setDetail(json);
  }

  async function recurate() {
    setBusy("Retagging rooms…");
    setError(null);
    try {
      await savePhotos();
      const response = await fetch(`/api/tours/${tourId}/curate`, {
        method: "POST",
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "Curation failed");
      setDetail(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Curation failed");
    } finally {
      setBusy(null);
    }
  }

  async function generate() {
    setBusy("Starting generation…");
    setError(null);
    try {
      await savePhotos();
      const response = await fetch(`/api/tours/${tourId}/generate`, {
        method: "POST",
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "Generate failed");
      setDetail(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generate failed");
    } finally {
      setBusy(null);
    }
  }

  async function retryClip(clipId: string) {
    setBusy("Retrying clip…");
    setError(null);
    try {
      const response = await fetch(
        `/api/tours/${tourId}/clips/${clipId}/retry`,
        { method: "POST" },
      );
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "Retry failed");
      setDetail(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Retry failed");
    } finally {
      setBusy(null);
    }
  }

  function movePhoto(index: number, direction: -1 | 1) {
    setDetail((current) => {
      if (!current) return current;
      const photos = [...current.photos];
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= photos.length) return current;
      const swap = photos[index];
      photos[index] = photos[nextIndex];
      photos[nextIndex] = swap;
      return {
        ...current,
        photos: photos.map((photo, sortOrder) => ({
          ...photo,
          sort_order: sortOrder,
        })),
      };
    });
  }

  if (!detail) {
    return (
      <main className="mx-auto max-w-6xl px-6 py-16 text-[var(--muted)]">
        {error ?? "Loading tour…"}
      </main>
    );
  }

  const { tour, photos, clips, masterUrl } = detail;
  const generating = ACTIVE.has(tour.status);
  const staleGeneration = generating && isGenerationStale(tour.updated_at);
  const blockingGeneration = generating && !staleGeneration;
  const includedCount = photos.filter((photo) => !photo.rejected).length;

  return (
    <main className="mx-auto w-full max-w-6xl px-6 pb-24">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.28em] text-[var(--brass)]">
            {tour.status}
          </p>
          <h1 className="serif mt-2 text-4xl tracking-tight md:text-5xl">
            {tour.title}
          </h1>
          <p className="mt-2 text-[var(--muted)]">
            {tour.progress_label || "Review the walkthrough order, then generate."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void recurate()}
            disabled={Boolean(busy) || blockingGeneration}
            className="rounded-full border border-[var(--line)] bg-white/60 px-4 py-2 text-sm disabled:opacity-50"
          >
            Re-tag rooms
          </button>
          <button
            type="button"
            onClick={() => void generate()}
            disabled={Boolean(busy) || blockingGeneration || includedCount === 0}
            className="rounded-full bg-ink px-5 py-2 text-sm text-[var(--paper)] disabled:opacity-50"
          >
            {blockingGeneration
              ? "Generating…"
              : staleGeneration
                ? "Resume generation"
                : busy ?? "Generate tour"}
          </button>
        </div>
      </div>

      {tour.error && (
        <p className="mt-4 rounded-2xl border border-[var(--danger)]/30 bg-white/70 px-4 py-3 text-sm text-[var(--danger)]">
          {tour.error}
        </p>
      )}
      {error && (
        <p className="mt-4 text-sm text-[var(--danger)]">{error}</p>
      )}

      {generating && (
        <div className="mt-6 h-1 overflow-hidden rounded-full bg-[var(--paper-2)]">
          <div
            className="h-full bg-[var(--brass)] transition-all"
            style={{
              width: `${Math.min(
                95,
                tour.clip_count
                  ? (tour.current_clip_index / Math.max(tour.clip_count, 1)) * 100
                  : 12,
              )}%`,
            }}
          />
        </div>
      )}

      {masterUrl && (
        <section className="mt-8 overflow-hidden rounded-3xl border border-[var(--line)] bg-black">
          <video
            className="aspect-video w-full"
            src={masterUrl}
            controls
            playsInline
          />
          <div className="flex items-center justify-between px-5 py-3 text-sm text-[var(--paper)]">
            <span>Master walkthrough</span>
            <a
              href={masterUrl}
              download
              className="inline-flex items-center gap-2 text-[var(--brass-2)]"
            >
              <Download size={16} />
              Download MP4
            </a>
          </div>
        </section>
      )}

      {clips.length > 0 && (
        <section className="mt-10">
          <h2 className="serif text-2xl">Clips</h2>
          <ul className="mt-4 grid gap-3 md:grid-cols-2">
            {clips.map((clip) => {
              const endPhoto = clip.end_photo_id
                ? photos.find((photo) => photo.id === clip.end_photo_id)
                : undefined;
              const title = endPhoto
                ? clipLabel(
                    (clip.room_type as RoomType) ?? "other",
                    endPhoto.room_type,
                  )
                : ROOM_LABELS[(clip.room_type as RoomType) ?? "other"];
              return (
              <li
                key={clip.id}
                className="rounded-2xl border border-[var(--line)] bg-white/55 p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">{title}</p>
                    <p className="text-sm capitalize text-[var(--muted)]">
                      {clip.status}
                      {clip.camera_move ? ` · ${clip.camera_move}` : ""}
                    </p>
                    {clip.error && (
                      <p className="mt-2 text-sm text-[var(--danger)]">
                        {clip.error}
                      </p>
                    )}
                    {clip.prompt && clip.end_photo_id && (
                      <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-[var(--muted)]">
                        {clip.prompt}
                      </p>
                    )}
                  </div>
                  {(clip.status === "failed" ||
                    clip.status === "completed" ||
                    clip.status === "submitted") && (
                    <button
                      type="button"
                      onClick={() => void retryClip(clip.id)}
                      disabled={Boolean(busy) || blockingGeneration}
                      className="inline-flex items-center gap-1 rounded-full border border-[var(--line)] px-3 py-1 text-xs disabled:opacity-50"
                    >
                      <RefreshCw size={12} />
                      Retry
                    </button>
                  )}
                </div>
                {clip.playbackUrl && (
                  <video
                    className="mt-3 aspect-video w-full rounded-xl bg-ink"
                    src={clip.playbackUrl}
                    controls
                    playsInline
                  />
                )}
              </li>
            );
            })}
          </ul>
        </section>
      )}

      <section className="mt-10">
        <div className="flex items-end justify-between">
          <h2 className="serif text-2xl">Walkthrough order</h2>
          <p className="text-sm text-[var(--muted)]">
            {includedCount} included · floorplans and dupes stay excluded
          </p>
        </div>
        <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {photos.map((photo, index) => (
            <li
              key={photo.id}
              className={`overflow-hidden rounded-2xl border bg-white/60 ${
                photo.rejected
                  ? "border-[var(--line)] opacity-60"
                  : "border-[var(--brass)]/35"
              }`}
            >
              <div className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={photo.url}
                  alt={photo.original_filename ?? "Listing photo"}
                  className="aspect-[4/3] w-full object-cover"
                />
                {photo.is_hero && !photo.rejected && (
                  <span className="absolute left-3 top-3 rounded-full bg-ink/80 px-2 py-1 text-[10px] uppercase tracking-wider text-[var(--paper)]">
                    Hero
                  </span>
                )}
              </div>
              <div className="space-y-3 p-3">
                <div className="flex items-center gap-2">
                  <select
                    value={photo.room_type}
                    onChange={(event) => {
                      const room_type = event.target.value as RoomType;
                      setDetail((current) =>
                        current
                          ? {
                              ...current,
                              photos: current.photos.map((item) =>
                                item.id === photo.id
                                  ? { ...item, room_type }
                                  : item,
                              ),
                            }
                          : current,
                      );
                    }}
                    className="w-full rounded-lg border border-[var(--line)] bg-transparent px-2 py-1 text-sm"
                  >
                    {WALKTHROUGH_ORDER.map((room) => (
                      <option key={room} value={room}>
                        {ROOM_LABELS[room]}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => movePhoto(index, -1)}
                    className="rounded-lg border border-[var(--line)] p-1"
                    aria-label="Move up"
                  >
                    <ChevronUp size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={() => movePhoto(index, 1)}
                    className="rounded-lg border border-[var(--line)] p-1"
                    aria-label="Move down"
                  >
                    <ChevronDown size={16} />
                  </button>
                </div>
                <label className="flex items-center gap-2 text-sm text-[var(--muted)]">
                  <input
                    type="checkbox"
                    checked={!photo.rejected}
                    onChange={(event) => {
                      const rejected = !event.target.checked;
                      setDetail((current) =>
                        current
                          ? {
                              ...current,
                              photos: current.photos.map((item) =>
                                item.id === photo.id
                                  ? { ...item, rejected }
                                  : item,
                              ),
                            }
                          : current,
                      );
                    }}
                  />
                  Include in tour
                </label>
                {photo.reject_reason && (
                  <p className="text-xs text-[var(--muted)]">
                    Flagged: {photo.reject_reason}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
