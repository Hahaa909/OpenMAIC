import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { ManifestScene } from '@/lib/export/classroom-zip-types';
import { PlaybackController, type PlaybackState } from './controller';
import { createMediaLibrary, type MediaLibrary } from './media-library';
import { NarrationPlayer, VideoRegistry, WidgetChannel } from './media-ports';

export interface Playback {
  state: PlaybackState;
  media: MediaLibrary;
  videos: VideoRegistry;
  widgets: WidgetChannel;
  /** Play / continue / resume. Must be called from a user gesture (click, key press). */
  play(): void;
  pause(): void;
  toggle(): void;
  dismissDiscussion(): void;
}

/**
 * Binds the playback controller to the player: one controller and one set of
 * media ports per document, reporting the scene index the app shows.
 */
export function usePlayback(
  scenes: readonly ManifestScene[],
  index: number,
  navigate: (index: number) => void,
): Playback {
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);

  const { controller, media, narration, videos, widgets } = useMemo(() => {
    const media = createMediaLibrary(document);
    const narration = new NarrationPlayer(media);
    const videos = new VideoRegistry();
    const widgets = new WidgetChannel();
    const controller = new PlaybackController({
      scenes,
      navigate: (next) => navigateRef.current(next),
      ports: {
        playAudio: (ref, control) => narration.play(ref, control),
        playVideo: (elementId, control) => videos.play(elementId, control),
        sendWidgetMessage: (type, payload) => widgets.send(type, payload),
      },
    });
    return { controller, media, narration, videos, widgets };
  }, [scenes]);

  useEffect(
    () => () => {
      controller.dispose();
      narration.stop();
      media.dispose();
    },
    [controller, media, narration],
  );

  // Effects run after the commit, so the new scene's video elements and
  // iframe are registered before its actions start.
  useEffect(() => {
    controller.sceneShown(index);
  }, [controller, index]);

  const state = useSyncExternalStore(controller.subscribe, controller.getState);

  const play = useCallback(() => {
    narration.prime();
    controller.play();
  }, [controller, narration]);
  const toggle = useCallback(() => {
    narration.prime();
    controller.toggle();
  }, [controller, narration]);
  const pause = useCallback(() => controller.pause(), [controller]);
  const dismissDiscussion = useCallback(() => controller.dismissDiscussion(), [controller]);

  return { state, media, videos, widgets, play, pause, toggle, dismissDiscussion };
}
