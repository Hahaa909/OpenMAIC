// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/lib/standalone-player/App';
import type { PlayerData } from '@/lib/standalone-player/read-data';
import type { ManifestScene } from '@/lib/export/classroom-zip-types';
import {
  STANDALONE_PLAYER_STRING_KEYS,
  type StandalonePlayerStrings,
} from '@/lib/export/standalone-html/contract';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const strings = Object.fromEntries(
  STANDALONE_PLAYER_STRING_KEYS.map((key) => [key, `[${key}]`]),
) as StandalonePlayerStrings;

function quiz(title: string): ManifestScene {
  return {
    type: 'quiz',
    title,
    order: 0,
    content: {
      type: 'quiz',
      questions: [
        { id: 'q', type: 'single', question: 'Q?', options: [{ value: 'A', label: 'a' }] },
      ],
    } as ManifestScene['content'],
    actions: [{ id: 's', type: 'speech', text: 'Read the question.' } as never],
  };
}

const scenes = [quiz('One'), quiz('Two'), quiz('Three')];
const data: PlayerData = {
  manifest: {
    formatVersion: 1,
    exportedAt: '',
    appVersion: '',
    stage: { name: 'Course', createdAt: 0, updatedAt: 0 },
    agents: [],
    scenes,
    mediaIndex: {},
  },
  scenes,
  config: { strings },
};

let root: Root;
let host: HTMLElement;

function render() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(createElement(App, { data })));
}
const overlay = () => host.querySelector('[data-testid=start-overlay]');
const sceneIndex = () =>
  host.querySelector('[data-testid=scene]')?.getAttribute('data-scene-index');

beforeEach(() => {
  history.replaceState(null, '', '#');
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('standalone player start overlay', () => {
  it('shows on the scene the file opens on, a #scene-N link included', () => {
    history.replaceState(null, '', '#scene-2');
    render();
    expect(sceneIndex()).toBe('1');
    expect(overlay()).not.toBeNull();
  });

  it('goes away on any navigation before playing, including a hash change', () => {
    render();
    expect(overlay()).not.toBeNull();
    act(() => {
      history.replaceState(null, '', '#scene-3');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(sceneIndex()).toBe('2');
    expect(overlay()).toBeNull();
  });

  it('goes away on the Next button', () => {
    render();
    act(() => (host.querySelector('[data-testid=next]') as HTMLButtonElement).click());
    expect(overlay()).toBeNull();
  });
});

describe('standalone player Space key', () => {
  it('leaves Space to scroll a quiz when focus is inside the scene', () => {
    render();
    const scene = host.querySelector('[data-testid=scene]')!;
    const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    act(() => {
      scene.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(host.querySelector('[data-testid=play-toggle]')?.getAttribute('data-mode')).toBe('idle');
  });

  it('toggles playback when focus is outside the scene', () => {
    render();
    const header = host.querySelector('header')!;
    const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    act(() => {
      header.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(host.querySelector('[data-testid=play-toggle]')?.getAttribute('data-mode')).toBe(
      'playing',
    );
  });
});

describe('standalone player linked media', () => {
  let table: HTMLScriptElement | undefined;
  afterEach(() => {
    table?.remove();
    table = undefined;
    vi.restoreAllMocks();
  });

  function withLinkedMedia() {
    table = document.createElement('script');
    table.type = 'application/json';
    table.id = 'openmaic-media';
    table.textContent = JSON.stringify({
      'audio/audio-1.mp3': { mimeType: 'audio/mpeg', src: 'audio/audio-1.mp3' },
    });
    document.body.append(table);
    const created: HTMLMediaElement[] = [];
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const element = createElement(tag);
      if (element instanceof HTMLMediaElement) created.push(element);
      return element;
    }) as typeof document.createElement);
    // The probe, as opposed to the (idle) narration element.
    return () => created.filter((element) => element.getAttribute('src') === 'audio/audio-1.mp3');
  }
  const notice = () => host.querySelector('[data-testid=media-missing]');

  it('says the media folder is missing when the probe cannot load a file', () => {
    const probes = withLinkedMedia();
    render();
    expect(notice()).toBeNull();
    expect(probes()).toHaveLength(1);
    act(() => {
      probes()[0].dispatchEvent(new Event('error'));
    });
    expect(notice()?.textContent).toBe('[linkedFilesUnavailable]');
    expect(notice()?.getAttribute('role')).toBe('alert');
    // The classroom stays usable: the start overlay is still offered.
    expect(overlay()).not.toBeNull();
  });

  it('shows nothing when the files load', () => {
    const probes = withLinkedMedia();
    render();
    act(() => {
      probes()[0].dispatchEvent(new Event('loadedmetadata'));
    });
    expect(notice()).toBeNull();

describe('standalone player static fallback', () => {
  it('replaces the root content the file ships with when the player mounts', () => {
    host = document.createElement('div');
    host.innerHTML = '<p class="openmaic-fallback">needs JavaScript</p>';
    document.body.append(host);
    expect(host.querySelector('.openmaic-fallback')).not.toBeNull();
    root = createRoot(host);
    act(() => root.render(createElement(App, { data })));
    expect(host.querySelector('.openmaic-fallback')).toBeNull();
    expect(host.querySelector('[data-testid=scene]')).not.toBeNull();
  });
});

describe('standalone player captions', () => {
  it('sits in its own strip on narrow screens and overlays the scene from sm up', () => {
    render();
    const bar = host.querySelector('[data-testid=caption-bar]') as HTMLElement;
    expect(bar).not.toBeNull();
    const classes = bar.className.split(/\s+/);
    // Never absolutely positioned below the sm breakpoint.
    expect(classes).not.toContain('absolute');
    expect(classes).toContain('sm:absolute');
    // A sibling of the scene, not inside it.
    expect(host.querySelector('[data-testid=scene]')!.contains(bar)).toBe(false);
  });
});
