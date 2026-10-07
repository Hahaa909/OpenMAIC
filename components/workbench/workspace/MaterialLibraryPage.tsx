'use client';

/**
 * The knowledge base page (RFC #1716 §7): the material library, opened from
 * the foot of the rail, filling the main area. In the UI it is the Knowledge
 * base; code and APIs keep "material library" (§10).
 *
 * The shell mounts it only while `?view=library` is set and keeps the
 * conversation and classroom panes mounted, hidden, underneath it.
 */
import { useI18n } from '@/lib/hooks/use-i18n';

export function MaterialLibraryPage() {
  const { t } = useI18n();
  return (
    <main
      data-testid="pro-workspace-library"
      aria-labelledby="pro-workspace-library-title"
      className="ws-canvas relative flex min-w-0 flex-1 flex-col overflow-y-auto"
    >
      <div className="mx-auto w-full max-w-[1100px] px-5 pb-16 pt-8 sm:px-8">
        <h1 id="pro-workspace-library-title" className="text-[20px] font-semibold">
          {t('workspace.knowledgeBase.title')}
        </h1>
      </div>
    </main>
  );
}
