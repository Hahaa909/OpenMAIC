/**
 * DOM side of the sequencer ports: the narration `<audio>` element, the slide
 * `<video>` elements, and the interactive scene's iframe channel.
 *
 * Autoplay: browsers only let media with sound start from a user gesture.
 * Playback starts from the Play button, whose click handler calls
 * {@link NarrationPlayer.prime} to start the one shared narration element
 * inside that gesture (WebKit then allows the same element to play later
 * clips). A `play()` that is still refused falls back to the reading timer for
 * speech, and to muted playback for video.
 */
import { MAX_VIDEO_WAIT_MS } from '@/lib/choreography/timing';
import { pausableDelay, type StepControl } from './pause-gate';
import type { MediaLibrary } from './media-library';

/** 0.1 s of silent 8 kHz mono PCM, used to unlock the narration element. */
function silentWavDataUri(): string {
  const samples = 800;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++) {
      bytes[offset + index] = text.charCodeAt(index);
    }
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  ascii(36, 'data');
  view.setUint32(40, samples, true);
  bytes.fill(128, 44); // 8-bit PCM silence
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

/** Extra time past a video's own duration before playback stops waiting for it. */
const VIDEO_END_GRACE_MS = 3000;
/** Cap for a video whose duration is unknown. */
const VIDEO_UNKNOWN_DURATION_CAP_MS = 60_000;

export class NarrationPlayer {
  private readonly audio: HTMLAudioElement;
  private primed = false;

  constructor(private readonly media: MediaLibrary) {
    this.audio = new Audio();
    this.audio.preload = 'auto';
  }

  /** Call from inside the Play click handler (a user gesture). */
  prime(): void {
    if (this.primed) return;
    this.primed = true;
    try {
      this.audio.src = silentWavDataUri();
      void this.audio.play().catch(() => {});
    } catch {
      // Priming is best effort; refused clips fall back to the reading timer.
    }
  }

  play(ref: string, control: StepControl): Promise<boolean> {
    const src = this.media.resolve(ref);
    if (!src || control.signal.aborted) return Promise.resolve(false);
    const audio = this.audio;
    return new Promise<boolean>((resolve) => {
      let started = false;
      let settled = false;
      const finish = (result: boolean) => {
        if (settled) return;
        settled = true;
        audio.removeEventListener('ended', onEnded);
        audio.removeEventListener('error', onError);
        unsubscribe();
        control.signal.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const onEnded = () => finish(true);
      // A clip that fails before it starts is paced by the reading timer; one
      // that fails midway simply ends.
      const onError = () => finish(started);
      const onAbort = () => {
        audio.pause();
        finish(true);
      };
      const start = () => {
        audio.play().then(
          () => {
            started = true;
          },
          (error: unknown) => {
            // A pause() racing the start rejects with AbortError; resume
            // calls start() again. Anything else means it cannot play.
            if (control.gate.paused || control.signal.aborted) return;
            if (error instanceof DOMException && error.name === 'AbortError') return;
            finish(false);
          },
        );
      };
      const unsubscribe = control.gate.subscribe((paused) => {
        if (paused) audio.pause();
        else start();
      });
      audio.addEventListener('ended', onEnded);
      audio.addEventListener('error', onError);
      control.signal.addEventListener('abort', onAbort, { once: true });
      audio.src = src;
      audio.currentTime = 0;
      if (!control.gate.paused) start();
    });
  }

  stop(): void {
    this.audio.pause();
  }
}

/** Slide `<video>` elements by element id, registered as the slide renders them. */
export class VideoRegistry {
  private readonly elements = new Map<string, HTMLVideoElement>();

  register(elementId: string, video: HTMLVideoElement | null): void {
    if (video) this.elements.set(elementId, video);
    else this.elements.delete(elementId);
  }

  async play(elementId: string, control: StepControl): Promise<void> {
    const video = this.elements.get(elementId);
    // Not embedded (poster only) or not on this slide: nothing to wait for.
    if (!video || !(video.currentSrc || video.getAttribute('src')) || control.signal.aborted) {
      return;
    }

    let stopWaiting = () => {};
    const ended = new Promise<void>((resolve) => {
      stopWaiting = () => {
        video.removeEventListener('ended', stopWaiting);
        video.removeEventListener('error', stopWaiting);
        resolve();
      };
      video.addEventListener('ended', stopWaiting);
      video.addEventListener('error', stopWaiting);
    });
    const start = async (): Promise<boolean> => {
      try {
        await video.play();
        return true;
      } catch (error) {
        if (control.gate.paused || control.signal.aborted) return true;
        if (error instanceof DOMException && error.name === 'NotAllowedError' && !video.muted) {
          // Sound refused outside a gesture: muted playback is always allowed.
          video.muted = true;
          return start();
        }
        return false;
      }
    };
    const unsubscribe = control.gate.subscribe((paused) => {
      if (paused) video.pause();
      else void start();
    });
    try {
      video.currentTime = 0;
      if (!(await start())) return;
      const capMs = Number.isFinite(video.duration)
        ? Math.min(video.duration * 1000 + VIDEO_END_GRACE_MS, MAX_VIDEO_WAIT_MS)
        : VIDEO_UNKNOWN_DURATION_CAP_MS;
      await Promise.race([ended, pausableDelay(capMs, control)]);
    } finally {
      unsubscribe();
      stopWaiting();
      if (control.signal.aborted) video.pause();
    }
  }
}

/** Posts widget messages to the interactive scene's iframe, queued until it loads. */
export class WidgetChannel {
  private frame: HTMLIFrameElement | null = null;
  private loaded = false;
  private queue: Array<Record<string, unknown>> = [];

  attach(frame: HTMLIFrameElement | null): void {
    if (frame === this.frame) return;
    this.frame = frame;
    this.loaded = false;
    this.queue = [];
  }

  markLoaded(frame: HTMLIFrameElement): void {
    if (frame !== this.frame) return;
    this.loaded = true;
    const pending = this.queue;
    this.queue = [];
    for (const message of pending) this.post(message);
  }

  send(type: string, payload: Record<string, unknown>): void {
    const message = { type, ...payload };
    if (!this.frame) return;
    if (!this.loaded) {
      this.queue.push(message);
      return;
    }
    this.post(message);
  }

  private post(message: Record<string, unknown>): void {
    // The page runs in an opaque origin (no allow-same-origin), so the
    // classroom's '*' target is the only one that reaches it.
    this.frame?.contentWindow?.postMessage(message, '*');
  }
}
