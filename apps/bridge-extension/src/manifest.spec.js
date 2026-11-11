import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { RECORDER_MATCHES } from './recorder-matches.js';

describe('manifest', () => {
  it('manifest exposes nothing to pages', () => {
    const m = JSON.parse(
      readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'),
    );
    expect(m.manifest_version).toBe(3);
    expect(m.permissions).toEqual(['debugger', 'tabs', 'alarms', 'scripting']);
    expect(m.host_permissions).toEqual(RECORDER_MATCHES);
    for (const k of ['content_scripts', 'web_accessible_resources', 'key']) {
      expect(m).not.toHaveProperty(k);
    }
  });

  it('declares an empty action so chrome.action (the badge) exists', () => {
    const m = JSON.parse(
      readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'),
    );
    expect(m.action).toEqual({});
  });
});
