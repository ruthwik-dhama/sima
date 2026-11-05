import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const path = 'apps/extension/.output/chrome-mv3/manifest.json';

describe.runIf(existsSync(path))('production manifest', () => {
  const manifest = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};

  it('holds no development access', () => {
    expect(JSON.stringify(manifest.content_scripts)).not.toMatch(/localhost|127\.0\.0\.1/);
    expect(JSON.stringify(manifest.host_permissions)).not.toContain('5199');
  });

  it('reaches only the supported platforms and Ollama on this computer', () => {
    expect([...manifest.host_permissions].sort()).toEqual(
      [
        'https://*.gradescope.com/*',
        'https://*.vhlcentral.com/*',
        'https://*.webassign.net/*',
        'http://localhost/*',
        'http://127.0.0.1/*',
      ].sort(),
    );
    expect(manifest.optional_host_permissions ?? []).toEqual([]);
    expect(JSON.stringify(manifest)).not.toMatch(/openai|anthropic|googleapis/);
    expect(manifest.permissions.sort()).toEqual(['storage']);
  });

  it('declares a Sima icon at every size Chrome uses', () => {
    for (const size of ['16', '32', '48', '128']) {
      expect(manifest.icons[size]).toBeTruthy();
      expect(existsSync(`apps/extension/.output/chrome-mv3/${manifest.icons[size]}`)).toBe(true);
    }
  });

  it('exposes no web-accessible resources', () => {
    expect(manifest.web_accessible_resources ?? []).toEqual([]);
  });
});
