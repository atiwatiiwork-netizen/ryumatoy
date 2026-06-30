/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Product / slip images come from Supabase Storage in production.
  images: {
    remotePatterns: [{ protocol: 'https', hostname: '*.supabase.co' }],
  },
};

export default nextConfig;
