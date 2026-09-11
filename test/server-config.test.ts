import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeServerUrl, readServerUrl, saveServerUrl } from '../src/main/server-config';

const tempConfigPath = (): string => join(mkdtempSync(join(tmpdir(), 'sharkord-server-')), 'config.json');

describe('normalizeServerUrl', () => {
  it('accepts what people paste', () => {
    expect(normalizeServerUrl('sharkord.example.com')).toBe('https://sharkord.example.com');
    expect(normalizeServerUrl('https://sharkord.example.com/')).toBe('https://sharkord.example.com');
    expect(normalizeServerUrl('  http://192.168.1.10:4991  ')).toBe('http://192.168.1.10:4991');
    expect(normalizeServerUrl('https://chat.example.com/sharkord/')).toBe('https://chat.example.com/sharkord');
    expect(normalizeServerUrl('http://localhost:4991')).toBe('http://localhost:4991');
  });

  it('rejects things that cannot be a server', () => {
    expect(normalizeServerUrl('')).toBeNull();
    expect(normalizeServerUrl('   ')).toBeNull();
    expect(normalizeServerUrl('ftp://example.com')).toBeNull();
    expect(normalizeServerUrl('https://user:secret@example.com')).toBeNull();
    expect(normalizeServerUrl('not a url at all')).toBeNull();
  });
});

describe('server config file', () => {
  it('round-trips the chosen server', () => {
    const path = tempConfigPath();
    saveServerUrl(path, 'https://sharkord.example.com');

    expect(readServerUrl(path)).toBe('https://sharkord.example.com');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ url: 'https://sharkord.example.com' });
  });

  it('treats a missing, broken or hostile config as "no server chosen"', () => {
    expect(readServerUrl(tempConfigPath())).toBeNull();

    const broken = tempConfigPath();
    writeFileSync(broken, 'not json');
    expect(readServerUrl(broken)).toBeNull();

    const wrongShape = tempConfigPath();
    writeFileSync(wrongShape, JSON.stringify({ server: 'https://example.com' }));
    expect(readServerUrl(wrongShape)).toBeNull();

    const javascript = tempConfigPath();
    writeFileSync(javascript, JSON.stringify({ url: 'javascript:alert(1)' }));
    expect(readServerUrl(javascript)).toBeNull();
  });

  it('creates missing directories on save', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sharkord-server-')), 'nested', 'deeper', 'config.json');
    saveServerUrl(path, 'https://example.com');
    expect(readServerUrl(path)).toBe('https://example.com');
  });
});
