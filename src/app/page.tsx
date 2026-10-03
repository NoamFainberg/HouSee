import Link from "next/link";
import { HomeClient } from "@/components/HomeClient";
import { hasHiggsfieldEnv } from "@/lib/env";
import { listTours } from "@/lib/tours";

export const dynamic = "force-dynamic";

export default async function Home() {
  const tours = await listTours().catch(() => []);
  return (
    <div className="grain min-h-screen">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-6">
        <Link href="/" className="serif text-2xl tracking-tight">
          HouSee
        </Link>
        <p className="text-sm text-[var(--muted)]">Listing stills → cinematic tour</p>
      </header>
      <HomeClient initialTours={tours} configured={hasHiggsfieldEnv()} />
    </div>
  );
}
