export const TOUR_STATUSES = [
  "draft",
  "curating",
  "ready",
  "generating",
  "stitching",
  "complete",
  "failed",
] as const;

export type TourStatus = (typeof TOUR_STATUSES)[number];

export const CLIP_STATUSES = [
  "pending",
  "submitted",
  "completed",
  "failed",
] as const;

export type ClipStatus = (typeof CLIP_STATUSES)[number];

export const ROOM_TYPES = [
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
] as const;

export type RoomType = (typeof ROOM_TYPES)[number];

export type Tour = {
  id: string;
  title: string;
  status: TourStatus;
  progress_label: string | null;
  current_clip_index: number;
  clip_count: number;
  master_path: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type Photo = {
  id: string;
  tour_id: string;
  storage_path: string;
  original_filename: string | null;
  room_type: RoomType;
  quality_score: number | null;
  rejected: boolean;
  reject_reason: string | null;
  sort_order: number;
  is_hero: boolean;
  created_at: string;
};

export type Clip = {
  id: string;
  tour_id: string;
  photo_id: string | null;
  end_photo_id: string | null;
  room_type: RoomType | null;
  sort_order: number;
  status: ClipStatus;
  prompt: string | null;
  camera_move: string | null;
  /** Duration for locally rendered photo_hold clips (seconds). */
  hold_seconds?: number | null;
  /** User description of what is wrong with this reel, used on the last replace. */
  revision_note?: string | null;
  higgsfield_request_id: string | null;
  video_path: string | null;
  video_url: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type PhotoWithUrl = Photo & { url: string };
export type ClipWithUrl = Clip & { playbackUrl: string | null };

export type TourDetail = {
  tour: Tour;
  photos: PhotoWithUrl[];
  clips: ClipWithUrl[];
  masterUrl: string | null;
};
