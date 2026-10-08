'use client';

import { useState, useCallback } from 'react';
import { saveAs } from 'file-saver';
import { toast } from 'sonner';
import { useStageStore } from '@/lib/store/stage';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';
import type { Scene } from '@/lib/types/stage';
import type { LegacySpeechAction } from '@/lib/types/action';
import {
  STANDALONE_PLAYER_STRING_KEYS,
  type StandalonePlayerStrings,
} from './standalone-html/contract';
import {
  STANDALONE_HTML_SIZE_WARNING_BYTES,
  StandaloneHtmlTooLargeError,
} from './standalone-html/limits';

const log = createLogger('ExportHtml');

/** Whether any speech in the classroom has narration audio to embed. */
export function classroomHasNarration(scenes: readonly Scene[]): boolean {
  return scenes.some((scene) =>
    (scene.actions ?? []).some((action) => {
      if (action.type !== 'speech') return false;
      const speech = action as LegacySpeechAction;
      return !!speech.audioId || !!speech.audioUrl;
    }),
  );
}

function formatMegabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1);
}

export interface ExportHtmlOptions {
  /** Embed narration audio and video clips (see `buildStandaloneHtmlExport`). */
  includeNarration: boolean;
}

export function useExportHtml() {
  const [exporting, setExporting] = useState(false);
  const { t, locale } = useI18n();

  const exportStandaloneHtml = useCallback(
    async ({ includeNarration }: ExportHtmlOptions) => {
      const { stage, scenes } = useStageStore.getState();
      if (!stage?.id || scenes.length === 0) return;

      setExporting(true);
      const toastId = toast.loading(t('export.exporting'));

      try {
        // Loaded on demand: the export path pulls in the snapshot collectors,
        // which the header that hosts this hook should not carry.
        const { buildStandaloneHtmlExport, classroomUrlFor } =
          await import('./standalone-html/build-standalone-html');
        const strings = Object.fromEntries(
          STANDALONE_PLAYER_STRING_KEYS.map((key) => [key, t(`export.htmlPlayer.${key}`)]),
        ) as StandalonePlayerStrings;
        // Anyone with the link can open the classroom, so PBL scenes always
        // link back to it on this deployment.
        const classroomUrl = classroomUrlFor(window.location.origin, stage.id);

        const { blob, fileName, inlineFailures, unresolvedMedia, missingAudioCount, byteSize } =
          await buildStandaloneHtmlExport(stage, scenes, {
            strings,
            lang: locale,
            classroomUrl,
            includeNarration,
          });

        saveAs(blob, fileName);

        const partialCount = inlineFailures.length + unresolvedMedia.length + missingAudioCount;
        if (byteSize > STANDALONE_HTML_SIZE_WARNING_BYTES) {
          log.warn('Standalone HTML export is large:', { byteSize });
          toast.warning(t('export.htmlLarge', { size: formatMegabytes(byteSize) }), {
            id: toastId,
            description:
              partialCount > 0 ? t('export.inlinePartial', { count: partialCount }) : undefined,
          });
        } else if (partialCount > 0) {
          log.warn('Some referenced assets could not be embedded:', {
            inlineFailures,
            unresolvedMedia,
            missingAudioCount,
          });
          toast.warning(t('export.inlinePartial', { count: partialCount }), { id: toastId });
        } else {
          toast.success(t('export.exportSuccess'), { id: toastId });
        }
      } catch (error) {
        if (error instanceof StandaloneHtmlTooLargeError) {
          // Too large to build or open reliably as one file; a page plus a
          // media folder is the alternative for this case.
          log.warn('Standalone HTML export refused as too large:', error.estimatedBytes);
          toast.error(t('export.htmlTooLarge', { size: formatMegabytes(error.estimatedBytes) }), {
            id: toastId,
          });
          return;
        }
        log.error('Standalone HTML export failed:', error);
        toast.error(t('export.exportFailed'), { id: toastId });
      } finally {
        setExporting(false);
      }
    },
    [t, locale],
  );

  return { exporting, exportStandaloneHtml };
}
