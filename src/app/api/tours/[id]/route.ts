import { NextResponse } from "next/server";
import { z } from "zod";
import { getTourDetail, mutateTour } from "@/lib/store";
import type { RoomType } from "@/lib/types";

type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteCtx) {
  try {
    const { id } = await context.params;
    return NextResponse.json(await getTourDetail(id));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Tour not found" },
      { status: 404 },
    );
  }
}

const patchSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  photos: z
    .array(
      z.object({
        id: z.string().uuid(),
        room_type: z
          .enum([
            "exterior",
            "entry",
            "living",
            "kitchen",
            "dining",
            "bedroom",
            "bathroom",
            "balcony",
            "view",
            "amenity",
            "other",
            "floorplan",
          ])
          .optional(),
        rejected: z.boolean().optional(),
        sort_order: z.number().int().optional(),
      }),
    )
    .optional(),
});

export async function PATCH(request: Request, context: RouteCtx) {
  try {
    const { id } = await context.params;
    const body = patchSchema.parse(await request.json());
    await mutateTour(id, (record) => {
      if (body.title) record.tour.title = body.title;
      if (!body.photos) return;
      for (const patch of body.photos) {
        const photo = record.photos.find((item) => item.id === patch.id);
        if (!photo) continue;
        if (patch.room_type) photo.room_type = patch.room_type as RoomType;
        if (patch.rejected !== undefined) {
          photo.rejected = patch.rejected;
          if (!patch.rejected) photo.reject_reason = null;
        }
        if (patch.sort_order !== undefined) photo.sort_order = patch.sort_order;
      }
    });
    return NextResponse.json(await getTourDetail(id));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Update failed" },
      { status: 400 },
    );
  }
}
