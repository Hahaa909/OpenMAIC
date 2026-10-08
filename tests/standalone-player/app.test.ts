// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
