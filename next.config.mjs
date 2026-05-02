/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverComponentsExternalPackages: ['pdfjs-dist'],
    outputFileTracingIncludes: {
      '/api/fetch-calendar': ['./node_modules/pdfjs-dist/legacy/build/**'],
    },
  },
};

export default nextConfig;
