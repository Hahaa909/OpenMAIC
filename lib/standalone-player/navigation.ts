/**
 * Pure scene-routing rules of the standalone player: which scene a URL hash
 * names, and which navigation a key press means. Kept free of React and the
 * DOM so the rules are unit-testable.
 */

export type NavigationAction = 'previous' | 'next';

export function clampSceneIndex(index: number, count: number): number {
  if (count <= 0 || !Number.isFinite(index)) return 0;
  return Math.min(Math.max(Math.trunc(index), 0), count - 1);
}

/** `#scene-3` names the third scene (1-based, matching the visible counter). */
export function sceneHash(index: number): string {
  return `#scene-${index + 1}`;
}

/** The scene index a location hash names, or `0` for anything unrecognized. */
export function sceneIndexFromHash(hash: string, count: number): number {
  const match = /^#scene-(\d+)$/.exec(hash);
  return match ? clampSceneIndex(Number(match[1]) - 1, count) : 0;
}

export function applyNavigation(index: number, action: NavigationAction, count: number): number {
  switch (action) {
    case 'previous':
      return clampSceneIndex(index - 1, count);
    case 'next':
      return clampSceneIndex(index + 1, count);
  }
}

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * The navigation a key press asks for, or `null`. Only Left/Right navigate:
 * Up/Down, PageUp/PageDown and Home/End keep scrolling long quiz and PBL
 * scenes. Keys typed into a form field (a quiz answer) or with a modifier held
 * are never navigation.
 */
export function navigationActionForKey(event: {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  target?: { tagName?: string; isContentEditable?: boolean } | null;
}): NavigationAction | null {
  if (event.altKey || event.ctrlKey || event.metaKey) return null;
  const target = event.target;
  if (target && (EDITABLE_TAGS.has(target.tagName ?? '') || target.isContentEditable)) return null;
  switch (event.key) {
    case 'ArrowLeft':
      return 'previous';
    case 'ArrowRight':
      return 'next';
    default:
      return null;
  }
}

const ACTIVATABLE_TAGS = new Set(['BUTTON', 'A', 'SUMMARY', 'INPUT', 'TEXTAREA', 'SELECT']);

/**
 * Whether a key press toggles playback: Space, with no modifier, outside
 * anything Space already activates or types into (a focused button presses
 * itself, so handling it here too would toggle twice).
 */
export function isPlaybackToggleKey(event: {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  target?: { tagName?: string; isContentEditable?: boolean } | null;
}): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  if (event.key !== ' ' && event.key !== 'Spacebar') return false;
  const target = event.target;
  return !(target && (ACTIVATABLE_TAGS.has(target.tagName ?? '') || target.isContentEditable));
}
