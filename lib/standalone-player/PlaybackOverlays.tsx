import { ExternalLink, MessagesSquare, Play, X } from 'lucide-react';
import type { StandalonePlayerStrings } from '@/lib/export/standalone-html/contract';
import { safeClassroomUrl } from './scenes/PblScene';

/**
 * The current speech line. Over the bottom of the scene on wide screens; on
 * narrow ones a strip of its own below the scene (space kept while captions
 * are on, so the scene does not resize with every line).
 */
export function CaptionBar({ text }: { text: string }) {
  return (
    <div
      className="pointer-events-none z-20 flex min-h-[4.25rem] shrink-0 items-center justify-center bg-slate-900 px-3 py-1.5 sm:absolute sm:inset-x-0 sm:bottom-3 sm:min-h-0 sm:bg-transparent sm:px-6 sm:py-0"
      data-testid="caption-bar"
    >
      {text && (
        <p
          className="max-h-24 max-w-3xl overflow-y-auto text-center text-[13px] leading-snug text-white sm:max-h-none sm:overflow-visible sm:rounded-lg sm:bg-slate-900/80 sm:px-4 sm:py-2 sm:text-[15px] sm:leading-relaxed sm:shadow-lg"
          data-testid="caption"
          aria-live="polite"
        >
          {text}
        </p>
      )}
    </div>
  );
}

/**
 * A discussion point. The classroom opens a live AI discussion here; offline
 * the card names the topic, links to the online classroom when the export
 * knows it, and closes on its own as playback continues.
 */
export function DiscussionCard({
  topic,
  classroomUrl,
  strings,
  onDismiss,
}: {
  topic: string;
  classroomUrl?: string;
  strings: StandalonePlayerStrings;
  onDismiss: () => void;
}) {
  const href = safeClassroomUrl(classroomUrl);
  return (
    <div
      className="absolute right-4 top-4 z-30 w-80 max-w-[calc(100%-2rem)] rounded-xl border border-violet-200 bg-white p-4 shadow-xl"
      role="status"
      data-testid="discussion-card"
    >
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-violet-600">
        <MessagesSquare className="h-4 w-4" aria-hidden="true" />
        <span className="flex-1">{strings.discussionTitle}</span>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          aria-label={strings.discussionDismiss}
          title={strings.discussionDismiss}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
      <p className="text-sm leading-relaxed text-slate-800">{topic}</p>
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-violet-700 hover:underline"
          data-testid="discussion-link"
        >
          {strings.discussionContinueOnline}
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
      )}
    </div>
  );
}

/**
 * First-load call to action. Narration may only start from a user gesture, so
 * playback never starts on its own; clicking outside the button dismisses the
 * overlay and leaves the classroom to manual navigation.
 */
export function StartOverlay({
  label,
  onPlay,
  onDismiss,
}: {
  label: string;
  onPlay: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-slate-900/25"
      onClick={(event) => {
        if (event.target === event.currentTarget) onDismiss();
      }}
      data-testid="start-overlay"
    >
      <button
        type="button"
        onClick={onPlay}
        className="inline-flex items-center gap-2 rounded-full bg-violet-600 px-6 py-3 text-base font-semibold text-white shadow-xl hover:bg-violet-700 focus:outline-none focus-visible:ring-4 focus-visible:ring-violet-300"
        data-testid="start-playback"
        autoFocus
      >
        <Play className="h-5 w-5" aria-hidden="true" />
        {label}
      </button>
    </div>
  );
}
