/** @type {import('next').NextConfig} */
const nextConfig = {
  // This app has its own lockfile inside a repo that has another; pin the root
  // so Turbopack stops guessing (and warning) about which one is authoritative.
  turbopack: { root: import.meta.dirname },
  // Static export: the Worker serves the built files from its [assets] binding,
  // so the client and the API share one origin. No SSR runtime is needed — this
  // is a private single-user workspace with no SEO surface.
  output: "export",
  // Emitted into the directory wrangler.toml points [assets] at.
  distDir: "out",
  images: { unoptimized: true },
  // Trailing slashes keep static export paths and the asset router in agreement.
  trailingSlash: true,
};
export default nextConfig;
