import { createRoot } from 'react-dom/client';
import {
  STANDALONE_FALLBACK_CLASS,
  STANDALONE_ROOT_ELEMENT_ID,
} from '@/lib/export/standalone-html/contract';
import { App } from './App';
import { readPlayerData } from './read-data';

/**
 * The static message the file ships for viewers that do not run scripts. It
 * sits just before the player script, so it is only ever seen when the player
 * did not start; once it does, the message is removed. If the player fails
 * to start, the message switches to a generic "couldn't start" wording (JavaScript
 * is evidently running).
 */
function removeFallback(doc: Document): void {
  doc.querySelectorAll(`.${STANDALONE_FALLBACK_CLASS}`).forEach((el) => el.remove());
}

function showStartFailure(doc: Document): void {
  doc.querySelectorAll(`.${STANDALONE_FALLBACK_CLASS}`).forEach((el) => {
    const text = el.getAttribute('data-failed-text');
    if (text) el.textContent = text;
    el.setAttribute('data-failed', 'true');
  });
}

/** Mount the player into the document's root element, if present. */
export function mountPlayer(doc: Document): void {
  const root = doc.getElementById(STANDALONE_ROOT_ELEMENT_ID);
  if (!root) return;
  try {
    const data = readPlayerData(doc);
    createRoot(root, {
      onUncaughtError: (error) => {
        console.error(error);
        showStartFailure(doc);
      },
    }).render(<App data={data} />);
    removeFallback(doc);
  } catch (error) {
    console.error(error);
    showStartFailure(doc);
  }
}
