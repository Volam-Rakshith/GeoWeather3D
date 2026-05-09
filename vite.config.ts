import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** Set `VITE_BASE=/your-repo/` when deploying to GitHub Pages project sites; default `/` works on Vercel, Netlify, Cloudflare. */
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE ?? "/",
});
