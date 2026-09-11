import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type StoredServer = { url: string };

/**
 * Accepts what people actually paste: with or without a scheme, trailing slashes, ports,
 * LAN hostnames, IPs. Returns the canonical origin+path or null when it cannot be a server.
 */
export const normalizeServerUrl = (input: string): string | null => {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Anything without an explicit `scheme://` is treated as a host, so "sharkord.example.com"
  // and "nas:4991" both work while "ftp://…" and "javascript:…" still fail validation below.
  const withScheme = trimmed.includes('://') ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  if (url.username || url.password) return null;

  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
};

export const readServerUrl = (path: string): string | null => {
  try {
    const stored = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredServer>;
    return typeof stored.url === 'string' ? normalizeServerUrl(stored.url) : null;
  } catch {
    return null;
  }
};

export const saveServerUrl = (path: string, url: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ url } satisfies StoredServer, null, 2)}\n`);
};
