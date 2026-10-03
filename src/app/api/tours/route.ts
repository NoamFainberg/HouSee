import { NextResponse } from "next/server";
import { z } from "zod";
import { hasHiggsfieldEnv } from "@/lib/env";
import { createTour, listTours } from "@/lib/store";

const createSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
});

export async function GET() {
  try {
    const tours = await listTours();
    return NextResponse.json({
      tours,
      configured: hasHiggsfieldEnv(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list tours" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const json = await request.json().catch(() => ({}));
    const body = createSchema.parse(json);
    const tour = await createTour(body.title || "Untitled listing");
    return NextResponse.json({ tour });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create tour" },
      { status: 400 },
    );
  }
}
