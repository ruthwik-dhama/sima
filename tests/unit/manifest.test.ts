import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const path = 'apps/extension/.output/chrome-mv3/manifest.json';

describe.runIf(existsSync(path))('production manifest', () => {
  const manifest = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};

  it('holds no development access', () => {
    const text = JSON.stringify({
      host: manifest.host_permissions,
      scripts: manifest.content_scripts,
    });
    expect(text).not.toContain('localhost');
    expect(text).not.toContain('127.0.0.1');
  });

  it('keeps provider and local-model access optional', () => {
    expect(manifest.optional_host_permissions).toContain('https://api.openai.com/*');
    expect(manifest.host_permissions).not.toContain('https://api.openai.com/*');
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
