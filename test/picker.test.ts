import { describe, expect, it } from 'vitest';
import { describeSources, resolveChoice, type PickerSource } from '../src/main/picker';

type Source = Parameters<typeof describeSources>[0][number];

const source = (id: string, name: string, options: { thumbnail?: boolean; icon?: boolean } = {}): Source =>
  ({
    id,
    name,
    thumbnail: {
      isEmpty: () => options.thumbnail === false,
      toDataURL: () => `data:image/png;base64,${id}`
    },
    appIcon: {
      isEmpty: () => options.icon !== true,
      toDataURL: () => 'data:image/png;base64,icon'
    }
  }) as unknown as Source;

describe('describeSources', () => {
  it('hands the picker plain data instead of Electron objects', () => {
    const described = describeSources([source('screen:0:0', 'Entire screen', { icon: true })]);

    expect(described).toEqual<PickerSource[]>([
      {
        id: 'screen:0:0',
        name: 'Entire screen',
        thumbnail: 'data:image/png;base64,screen:0:0',
        icon: 'data:image/png;base64,icon'
      }
    ]);
  });

  it('reports missing thumbnails and icons as null', () => {
    const [described] = describeSources([source('window:1:0', 'Window', { thumbnail: false })]);

    expect(described?.thumbnail).toBeNull();
    expect(described?.icon).toBeNull();
  });
});

describe('resolveChoice', () => {
  const sources = [source('screen:0:0', 'Entire screen'), source('window:1:0', 'Editor')];

  it('returns the chosen source', () => {
    expect(resolveChoice(sources, 'window:1:0')?.id).toBe('window:1:0');
  });

  it('treats cancelling and unknown ids as no choice', () => {
    expect(resolveChoice(sources, null)).toBeNull();
    expect(resolveChoice(sources, 'window:9:9')).toBeNull();
  });
});
