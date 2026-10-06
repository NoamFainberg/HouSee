import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["sharp", "@higgsfield/client", "ffmpeg-static"],
  outputFileTracingIncludes: {
    "/api/tours/**": ["./node_modules/ffmpeg-static/ffmpeg"],
    "/api/inngest": ["./node_modules/ffmpeg-static/ffmpeg"],
  },
};

export default nextConfig;