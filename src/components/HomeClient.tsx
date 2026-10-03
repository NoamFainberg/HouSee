"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import type { Tour } from "@/lib/types";

export function HomeClient({
  initialTours,
  configured,
}: {
  initialTours: Tour[];
  configured: boolean;
}) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tours] = useState<Tour[]>(initialTours);

  const onDrop = useCallback((incoming: FileList | File[]) => {
    const next = Array.from(incoming).filter((file) =>
      file.type.startsWith("image/"),
    );
    setFiles((current) => [...current, ...next].slice(0, 20));
  }, []);

  async function createTour() {
    setError(null);
    if (files.length === 0) {
      setError("Add at least one listing photo.");
      return;
    }
    setBusy("Creating tour…");
    try {
      const created = await fetch("/api/tours", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title || "Untitled listing" }),
      });
      const createdJson = await created.json();
      if (!created.ok) throw new Error(createdJson.error || "Create failed");
      const tourId = createdJson.tour.id as string;

      setBusy("Uploading photos…");
      for (const [index, file] of files.entries()) {
        setBusy(`Uploading photos… ${index + 1}/${files.length}`);
        const form = new FormData();
        form.append("files", file);
        const uploaded = await fetch(`/api/tours/${tourId}/photos`, {
          method: "POST",
          body: form,
        });
        const uploadedJson = await uploaded.json();
        if (!uploaded.ok) throw new Error(uploadedJson.error || "Upload failed");
      }

      setBusy("Tagging rooms…");
      const curated = await fetch(`/api/tours/${tourId}/curate`, {
        method: "POST",
      });
      const curatedJson = await curated.json();
      if (!curated.ok) throw new Error(curatedJson.error || "Curation failed");

      router.push(`/tours/${tourId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setBusy(null);
    }
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-6 pb-20">
      <section className="grid gap-10 lg:grid-cols-[1.15fr_0.85fr] lg:items-end">
        <div>
          <p className="text-xs uppercase tracking-[0.28em] text-[var(--brass)]">
            Professional listing video
          </p>
          <h1 className="serif mt-3 max-w-xl text-5xl leading-[1.05] tracking-tight md:text-6xl">
            Still photos.
            <br />
            A house that moves.
          </h1>
          <p className="mt-5 max-w-lg text-base leading-7 text-[var(--muted)]">
            Upload Airbnb-style apartment photos. HouSee tags rooms, asks
            Higgsfield for cinematic camera moves, and stitches a 16:9 walkthrough.
          </p>
        </div>
        <div className="rounded-3xl border border-[var(--line)] bg-white/55 p-5 shadow-[0_20px_80px_rgba(22,17,12,0.06)] backdrop-blur">
          <label className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
            Listing title
          </label>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Bright 2BR in Jaffa"
            className="mt-2 w-full border-0 border-b border-[var(--line)] bg-transparent pb-2 text-lg outline-none"
          />
          <label
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (event.dataTransfer.files) onDrop(event.dataTransfer.files);
            }}
            className="mt-5 flex min-h-44 cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-[var(--brass)]/40 bg-[var(--paper)]/70 px-6 text-center"
          >
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/avif,.avif,.jpg,.jpeg,.png,.webp"
              multiple
              className="hidden"
              onChange={(event) => {
                if (event.target.files) onDrop(event.target.files);
              }}
            />
            <span className="serif text-xl">Drop listing photos</span>
            <span className="mt-2 text-sm text-[var(--muted)]">
              A few wide, well-lit stills. Three is enough for a POC.
            </span>
          </label>
          {files.length > 0 && (
            <p className="mt-3 text-sm text-[var(--muted)]">
              {files.length} photo{files.length === 1 ? "" : "s"} selected
            </p>
          )}
          {error && <p className="mt-3 text-sm text-[var(--danger)]">{error}</p>}
          {!configured && (
            <p className="mt-3 text-sm text-[var(--muted)]">
              Add Higgsfield keys in `.env.local` before generating a video.
              Uploading photos works without them.
            </p>
          )}
          <button
            type="button"
            onClick={() => void createTour()}
            disabled={Boolean(busy)}
            className="mt-5 w-full rounded-full bg-ink px-5 py-3 text-sm font-medium text-[var(--paper)] disabled:opacity-60"
          >
            {busy ?? "Create walkthrough"}
          </button>
        </div>
      </section>

      {tours.length > 0 && (
        <section className="mt-16">
          <h2 className="serif text-2xl">Recent tours</h2>
          <ul className="mt-5 grid gap-3 md:grid-cols-2">
            {tours.map((tour) => (
              <li key={tour.id}>
                <a
                  href={`/tours/${tour.id}`}
                  className="flex items-center justify-between rounded-2xl border border-[var(--line)] bg-white/50 px-5 py-4 hover:border-[var(--brass)]"
                >
                  <div>
                    <p className="font-medium">{tour.title}</p>
                    <p className="text-sm capitalize text-[var(--muted)]">
                      {tour.status.replace("_", " ")}
                    </p>
                  </div>
                  <span className="text-sm text-[var(--brass)]">Open</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
