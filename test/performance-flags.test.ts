import { expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {} }));

import { performanceFlags } from '../src/main/logger';

it('keeps Chromium frame pacing enabled while retaining Windows capture support', () => {
  expect(performanceFlags('linux')).toEqual([]);
  expect(performanceFlags('darwin')).toEqual([]);
  expect(performanceFlags('win32')).toEqual([
    ['enable-features', 'UseWindowsGraphicsCapture']
  ]);
});
