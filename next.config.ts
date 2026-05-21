import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["better-sqlite3"],
  // Allow large bulk-paste of reviews to addPastedReviews server action
  experimental: {
    serverActions: { bodySizeLimit: "10mb" },
  },
  // Make sure the on-boot seed xlsx ships with the deploy
  outputFileTracingIncludes: {
    "*": ["./seed/**/*"],
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "lh3.googleusercontent.com" },
      { protocol: "https", hostname: "lh4.googleusercontent.com" },
      { protocol: "https", hostname: "lh5.googleusercontent.com" },
      { protocol: "https", hostname: "lh6.googleusercontent.com" },
      { protocol: "https", hostname: "*.googleusercontent.com" },
    ],
  },
};

export default config;
