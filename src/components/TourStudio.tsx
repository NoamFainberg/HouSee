"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import { ROOM_LABELS, WALKTHROUGH_ORDER } from "@/lib/rooms";
import { isGenerationStale } from "@/lib/generation";
import type { ClipWithUrl, PhotoWithUrl, RoomType, TourDetail } from "@/lib/types";

const ACTIVE = new Set(["generating", "stitching", "curating"]);

function shotEnds(clip: ClipWithUrl, photos: PhotoWithUrl[]) {
  const included = photos.filter((photo) => !photo.rejected);
  const start = photos.find((photo) => photo.id === clip.photo_id);
  const end = clip.end_photo_id
    ? photos.find((photo) => photo.id === clip.end_photo_id)
    : undefined;
  const startIndex = start
    ? included.findIndex((photo) => photo.id === start.id)
    : -1;
  const endIndex = end ? included.findIndex((photo) => photo.id === end.id) : -1;
  return { start, end, startIndex, endIndex };
}

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
  const [selectedClipId, setSelectedClipId] = useState<string | null>(
    initial?.clips[0]?.id ?? null,
  );
  const [note, setNote] = useState(initial?.clips[0]?.revision_note ?? "");

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/tours/${tourId}`, { cache: "no-store" });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error || "Could not load tour");
    setDetail(json);
  }, [tourId]);

  const tourStatus = detail?.tour.status;
  const resumedStitch = useRef(false);
  useEffect(() => {
    if (resumedStitch.current || tourStatus !== "failed") return;
    const message = detail?.tour.error ?? "";
    const label = detail?.tour.progress_label ?? "";
    const stitchFailed = label === "Stitch failed" || /ffmpeg|stitch/i.test(message);
    const clips = detail?.clips ?? [];
    const clipsReady =
      clips.length > 0 &&
      clips.every((clip) => clip.status === "completed" && clip.video_path);
    if (!stitchFailed || !clipsReady) return;
    const kick = setTimeout(() => {
      resumedStitch.current = true;
      setDetail((current) => {
        if (!current || current.tour.status !== "failed") return current;
        return {
          ...current,
          tour: {
            ...current.tour,
            status: "stitching",
            progress_label: "Stitching master cut…",
            error: null,
          },
        };
      });
    }, 0);
    return () => clearTimeout(kick);
  }, [tourStatus, detail]);

  useEffect(() => {
    if (!tourStatus || !ACTIVE.has(tourStatus)) return;
    const kick = setTimeout(() => {
      void refresh().catch(() => undefined);
    }, 0);
    const timer = setInterval(() => {
      void refresh().catch(() => undefined);
    }, 8000);
    return () => {
      clearTimeout(kick);
      clearInterval(timer);
    };
  }, [tourStatus, refresh]);

  function selectClip(clip: ClipWithUrl) {
    setSelectedClipId(clip.id);
    setNote(clip.revision_note ?? "");
  }

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

  async function generate() {
    setBusy("Building reel…");
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

  async function replaceReel(clipId: string) {
    const text = note.trim();
    if (text.length < 8) {
      setError("Describe what is wrong with this reel.");
      return;
    }
    setBusy("Replacing reel…");
    setError(null);
    try {
      const response = await fetch(`/api/tours/${tourId}/clips/${clipId}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: text }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "Replace failed");
      setDetail(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Replace failed");
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
  const included = photos.filter((photo) => !photo.rejected);
  const selected =
    clips.find((clip) => clip.id === selectedClipId) ?? clips[0] ?? null;
  const selectedEnds = selected ? shotEnds(selected, photos) : null;
  const canReplace = Boolean(selected?.end_photo_id);

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
          <p className="mt-2 max-w-xl text-[var(--muted)]">
            {tour.progress_label ||
              "Set the photo sequence, build the reel, then replace any shot that breaks the walk."}
          </p>
          {generating && (
            <p className="mt-2 max-w-xl text-sm text-[var(--muted)]">
              You can leave this page. The shots keep rendering, and the tour finishes when you open it again.
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => void generate()}
          disabled={Boolean(busy) || blockingGeneration || included.length === 0}
          className="rounded-full bg-ink px-5 py-2.5 text-sm text-[var(--paper)] disabled:opacity-50"
        >
          {blockingGeneration
            ? "Building reel…"
            : staleGeneration
              ? "Resume reel"
              : busy ?? (clips.length ? "Rebuild reel" : "Build reel")}
        </button>
      </div>

      <ol className="mt-6 flex flex-wrap gap-3 text-xs uppercase tracking-[0.16em] text-[var(--muted)]">
        <li className="text-ink">1 · Upload</li>
        <li className="text-ink">2 · Sequence</li>
        <li className={clips.length ? "text-ink" : ""}>3 · Reel</li>
      </ol>

      {tour.error && (
        <p className="mt-4 rounded-2xl border border-[var(--danger)]/30 bg-white/70 px-4 py-3 text-sm text-[var(--danger)]">
          {tour.error}
        </p>
      )}
      {error && <p className="mt-4 text-sm text-[var(--danger)]">{error}</p>}

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

      <section className="mt-8">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 className="serif text-2xl">Sequence</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              This order is the walk. Each photo blends into the next as a drone move inside the room.
            </p>
          </div>
          <p className="text-sm text-[var(--muted)]">{included.length} in the tour</p>
        </div>
        <ul className="mt-4 flex gap-3 overflow-x-auto pb-2">
          {photos.map((photo, index) => (
            <li
              key={photo.id}
              className={`w-52 shrink-0 overflow-hidden rounded-2xl border bg-white/70 ${
                photo.rejected ? "border-[var(--line)] opacity-50" : "border-[var(--brass)]/40"
              }`}
            >
              <div className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={photo.url}
                  alt={photo.original_filename ?? "Listing photo"}
                  className="aspect-[4/3] w-full object-cover"
                />
                <span className="absolute left-2 top-2 rounded-full bg-ink/80 px-2 py-1 text-[10px] uppercase tracking-wider text-[var(--paper)]">
                  {photo.rejected ? "Out" : String(included.findIndex((item) => item.id === photo.id) + 1)}
                </span>
              </div>
              <div className="space-y-2 p-2">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => movePhoto(index, -1)}
                    className="rounded-lg border border-[var(--line)] p-1"
                    aria-label="Move earlier"
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={() => movePhoto(index, 1)}
                    className="rounded-lg border border-[var(--line)] p-1"
                    aria-label="Move later"
                  >
                    <ChevronRight size={16} />
                  </button>
                  <select
                    value={photo.room_type}
                    onChange={(event) => {
                      const room_type = event.target.value as RoomType;
                      setDetail((current) =>
                        current
                          ? {
                              ...current,
                              photos: current.photos.map((item) =>
                                item.id === photo.id ? { ...item, room_type } : item,
                              ),
                            }
                          : current,
                      );
                    }}
                    className="min-w-0 flex-1 rounded-lg border border-[var(--line)] bg-transparent px-1 py-1 text-xs"
                  >
                    {WALKTHROUGH_ORDER.map((room) => (
                      <option key={room} value={room}>
                        {ROOM_LABELS[room]}
                      </option>
                    ))}
                  </select>
                </div>
                <label className="flex items-center gap-2 text-xs text-[var(--muted)]">
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
                                item.id === photo.id ? { ...item, rejected } : item,
                              ),
                            }
                          : current,
                      );
                    }}
                  />
                  Include
                </label>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {masterUrl && (
        <section className="mt-8 overflow-hidden rounded-3xl border border-[var(--line)] bg-black">
          <video className="aspect-video w-full" src={masterUrl} controls playsInline />
          <div className="flex items-center justify-between px-5 py-3 text-sm text-[var(--paper)]">
            <span>Full tour</span>
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

      <section className="mt-8 rounded-3xl bg-ink px-4 py-4 text-[var(--paper)] md:px-5">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 className="serif text-2xl">Reel</h2>
            <p className="mt-1 text-sm text-white/60">
              Each card is one blend. Pick a shot, say what is wrong, and that reel is replaced in the tour.
            </p>
          </div>
        </div>

        {clips.length === 0 ? (
          <p className="mt-6 rounded-2xl border border-white/10 px-4 py-8 text-center text-sm text-white/60">
            Build the reel to see the walk as separate shots.
          </p>
        ) : (
          <ul className="mt-4 flex gap-3 overflow-x-auto pb-2">
            {clips.map((clip, index) => {
              const ends = shotEnds(clip, photos);
              const active = clip.id === selected?.id;
              const poster = ends.start?.url;
              return (
                <li key={clip.id} className="w-44 shrink-0">
                  <button
                    type="button"
                    onClick={() => selectClip(clip)}
                    className={`w-full overflow-hidden rounded-2xl border text-left ${
                      active ? "border-[var(--brass-2)]" : "border-white/10"
                    }`}
                  >
                    <div className="relative aspect-video bg-black">
                      {clip.playbackUrl ? (
                        <video
                          className="h-full w-full object-cover"
                          src={clip.playbackUrl}
                          muted
                          playsInline
                        />
                      ) : poster ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={poster} alt="" className="h-full w-full object-cover opacity-80" />
                      ) : null}
                      <span className="absolute left-2 top-2 rounded-full bg-black/70 px-2 py-0.5 text-[10px] uppercase tracking-wider">
                        Shot {index + 1}
                      </span>
                    </div>
                    <div className="px-2 py-2 text-xs text-white/70">
                      {ends.end
                        ? `${ends.startIndex + 1} → ${ends.endIndex + 1}`
                        : "Still"}
                      <span className="mt-0.5 block capitalize text-white/45">
                        {clip.status === "submitted" ? "Replacing…" : clip.status}
                      </span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {selected && selectedEnds && (
          <div className="mt-4 grid gap-4 rounded-2xl border border-white/10 p-4 md:grid-cols-[1.2fr_0.8fr]">
            <div>
              {selected.playbackUrl ? (
                <video
                  key={selected.playbackUrl}
                  className="aspect-video w-full rounded-xl bg-black"
                  src={selected.playbackUrl}
                  controls
                  playsInline
                />
              ) : (
                <div className="flex aspect-video items-center justify-center rounded-xl bg-black/40 text-sm text-white/60">
                  {selected.status === "submitted" || selected.status === "pending"
                    ? "Replacing this reel…"
                    : "This shot has no video yet."}
                </div>
              )}
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-[var(--brass-2)]">
                {selectedEnds.end
                  ? `Shot ${clips.findIndex((clip) => clip.id === selected.id) + 1} · photo ${selectedEnds.startIndex + 1} → ${selectedEnds.endIndex + 1}`
                  : "Still frame"}
              </p>
              <h3 className="serif mt-2 text-2xl">What is wrong with this shot?</h3>
              <p className="mt-2 text-sm leading-6 text-white/60">
                The replacement keeps the same opening and closing photos. It still has to stay inside the room: no walls, no invented spaces, no jump to a different picture.
              </p>
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={400}
                rows={4}
                placeholder="It passes through the wall between the TV and the window. Glide along the open floor instead."
                className="mt-3 w-full resize-none rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm text-[var(--paper)] outline-none placeholder:text-white/35"
              />
              {selected.error && (
                <p className="mt-2 text-sm text-red-300">{selected.error}</p>
              )}
              <button
                type="button"
                onClick={() => void replaceReel(selected.id)}
                disabled={Boolean(busy) || blockingGeneration || !canReplace}
                className="mt-3 rounded-full bg-[var(--paper)] px-4 py-2 text-sm text-ink disabled:opacity-40"
              >
                Replace this reel
              </button>
              {!canReplace && (
                <p className="mt-2 text-xs text-white/50">
                  This card is a still. Rebuild the reel so each step is a blend into the next photo.
                </p>
              )}
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
