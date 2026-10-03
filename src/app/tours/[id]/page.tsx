import Link from "next/link";
import { TourStudio } from "@/components/TourStudio";
import { getTourDetail } from "@/lib/tours";
import type { TourDetail } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function TourPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let initial: TourDetail | null = null;
  try {
    initial = await getTourDetail(id);
  } catch {
    initial = null;
  }
  return (
    <div className="grain min-h-screen">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-6">
        <Link href="/" className="serif text-2xl tracking-tight">
          HouSee
        </Link>
        <Link href="/" className="text-sm text-[var(--muted)] hover:text-ink">
          All tours
        </Link>
      </header>
      <TourStudio tourId={id} initial={initial} />
    </div>
  );
}
