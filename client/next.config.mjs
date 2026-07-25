/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export — the Worker co-deploys `out/` and serves it single-origin.
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
};

export default nextConfig;
