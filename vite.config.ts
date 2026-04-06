import { defineConfig } from 'vite';
import glsl from 'vite-plugin-glsl';
import path from 'path';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));

export default defineConfig({
  plugins: [
    glsl(),
    {
      name: 'html-version',
      transformIndexHtml(html) {
        return html.replace(/%APP_VERSION%/g, pkg.version);
      }
    }
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src')
    }
  },
  server: {
    open: true
  }
});
