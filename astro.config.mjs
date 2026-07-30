import { defineConfig } from 'astro/config';

export default defineConfig({
  build: {
    // Output files as index.html and app.html instead of directories
    format: 'file'
  }
});