import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

const PLAYGROUND = process.env.SIMA_PLAYGROUND === '1';
const PLAYGROUND_MATCHES = ['http://localhost:5199/*', 'http://127.0.0.1:5199/*'];

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({ plugins: [tailwindcss()] }),
  outDir: PLAYGROUND ? '.output-e2e' : '.output',
  outDirTemplate: 'chrome-mv3',
  manifest: {
    name: 'Sima',
    description: 'Understand and work through learning activities, with you in control.',
    permissions: ['storage'],
    host_permissions: [
      'https://*.gradescope.com/*',
      'https://*.vhlcentral.com/*',
      'https://*.webassign.net/*',
      // Ollama on this computer, the only place question text is sent.
      'http://localhost/*',
      'http://127.0.0.1/*',
      // Development builds also read the mock platforms.
      ...(PLAYGROUND ? PLAYGROUND_MATCHES : []),
    ],
    action: { default_title: 'Open Sima' },
  },
  hooks: {
    'build:manifestGenerated': (_wxt, manifest) => {
      if (!PLAYGROUND) return;
      for (const script of manifest.content_scripts ?? []) {
        script.matches = [...(script.matches ?? []), ...PLAYGROUND_MATCHES];
      }
    },
  },
});
