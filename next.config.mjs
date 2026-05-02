/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverComponentsExternalPackages: ['pdfjs-dist', 'pdfjs-dist/legacy/build/pdf.mjs'],
  },
};

export default nextConfig;
