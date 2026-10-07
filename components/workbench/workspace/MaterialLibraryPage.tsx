'use client';

/**
 * The knowledge base page (RFC #1716 §7): the material library, opened from
 * the foot of the rail, filling the main area. In the UI it is the Knowledge
 * base; code and APIs keep "material library" (§10).
 *
 * The shell mounts it only while `?view=library` is set and keeps the
 * conversation and classroom panes mounted, hidden, underneath it.
 *
 * It shows sources only, in All, Unfiled or one folder, as cards or a list,
 * each with its processing state (§1), and the limits an upload is held to
 * before one starts (§8). The folder being looked at is the teacher's: nothing
 * but the teacher changes it.
 */
import { useEffect, useState, type ReactNode } from 'react';
import {
  File,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  Inbox,
  LayoutGrid,
  Library,
  List,
  Search,
} from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils/cn';
import {
  formatMaterialBytes,
  materialLibraryErrorKey,
  type LibraryFolder,
  type LibraryLimits,
  type LibraryMaterial,
  type LibraryScope,
  type MaterialExtractionStatus,
} from '@/lib/workbench/material-library-client';
import { useMaterialLibrary } from '@/lib/workbench/use-material-library';

/** How long typing settles before the listing is asked again. */
const QUERY_DEBOUNCE_MS = 300;

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** The RFC #1716 §1 label for a source's extraction state. */
export function extractionLabelKey(status: MaterialExtractionStatus): string {
  switch (status) {
    case 'pending':
    case 'running':
      return 'workspace.knowledgeBase.status.parsing';
    case 'done':
      return 'workspace.knowledgeBase.status.searchable';
    case 'failed':
      return 'workspace.knowledgeBase.status.failed';
    default:
      return 'workspace.knowledgeBase.status.stored';
  }
}

function useDebounced<T>(value: T, milliseconds: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), milliseconds);
    return () => clearTimeout(timer);
  }, [value, milliseconds]);
  return settled;
}

function MaterialIcon({ mime }: { readonly mime?: string }) {
  const className = 'size-4 shrink-0 text-[color:var(--ws-ink-mute)]';
  if (mime?.startsWith('image/')) return <FileImage className={className} aria-hidden="true" />;
  if (mime?.startsWith('audio/')) return <FileAudio className={className} aria-hidden="true" />;
  if (mime?.startsWith('video/')) return <FileVideo className={className} aria-hidden="true" />;
  if (mime?.startsWith('text/') || mime === 'application/pdf' || mime?.includes('document')) {
    return <FileText className={className} aria-hidden="true" />;
  }
  return <File className={className} aria-hidden="true" />;
}

function StatusLabel({
  material,
  t,
}: {
  readonly material: LibraryMaterial;
  readonly t: Translate;
}) {
  const { status, reason } = material.extraction;
  const label = t(extractionLabelKey(status));
  return (
    <span
      data-testid={`kb-status-${material.materialId}`}
      data-status={status}
      className={cn(
        'text-[12px]',
        status === 'failed'
          ? 'text-red-600 dark:text-red-400'
          : status === 'done'
            ? 'text-[color:var(--ws-ink-soft)]'
            : 'text-[color:var(--ws-ink-mute)]',
      )}
    >
      {label}
      {status === 'failed' && reason ? (
        <span className="block break-words text-[11px] opacity-90">
          {t('workspace.knowledgeBase.status.failedReason', { reason })}
        </span>
      ) : null}
    </span>
  );
}

function LimitsLine({
  limits,
  locale,
  t,
}: {
  readonly limits: LibraryLimits;
  readonly locale: string;
  readonly t: Translate;
}) {
  const bytes = (value: number) => formatMaterialBytes(value, locale);
  return (
    <p data-testid="kb-limits" className="text-[12px] leading-5 text-[color:var(--ws-ink-mute)]">
      {t('workspace.knowledgeBase.limits.perFile', {
        document: bytes(limits.documentMaxBytes),
        media: bytes(limits.mediaMaxBytes),
      })}
      {' · '}
      {t('workspace.knowledgeBase.limits.usage', {
        count: limits.usedCount,
        maxCount: limits.maxCount,
        bytes: bytes(limits.usedBytes),
        maxBytes: bytes(limits.maxTotalBytes),
      })}
      {' · '}
      {limits.assetQuotaBytes === null
        ? t('workspace.knowledgeBase.limits.storageUnlimited', {
            used: bytes(limits.assetUsedBytes),
          })
        : t('workspace.knowledgeBase.limits.storage', {
            used: bytes(limits.assetUsedBytes),
            quota: bytes(limits.assetQuotaBytes),
          })}
    </p>
  );
}

function ScopeNav({
  scope,
  folders,
  onSelect,
  t,
}: {
  readonly scope: LibraryScope;
  readonly folders: readonly LibraryFolder[];
  readonly onSelect: (scope: LibraryScope) => void;
  readonly t: Translate;
}) {
  const item = (
    testId: string,
    target: LibraryScope,
    label: string,
    icon: ReactNode,
    count?: number,
  ) => {
    const active =
      target.kind === scope.kind &&
      (target.kind !== 'folder' || (scope.kind === 'folder' && scope.folderId === target.folderId));
    return (
      <li key={testId}>
        <button
          type="button"
          data-testid={testId}
          aria-current={active ? 'page' : undefined}
          onClick={() => onSelect(target)}
          className={cn(
            'ws-row flex h-8 w-full min-w-0 items-center gap-2 px-2 text-left text-[13px]',
            active && 'ws-row-active',
          )}
        >
          {icon}
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {count !== undefined ? (
            <span className="ws-row-meta shrink-0 text-[11px]">{count}</span>
          ) : null}
        </button>
      </li>
    );
  };
  return (
    <nav aria-label={t('workspace.knowledgeBase.scope.aria')} className="md:w-52 md:shrink-0">
      <ul className="flex flex-col gap-0.5">
        {item(
          'kb-scope-all',
          { kind: 'all' },
          t('workspace.knowledgeBase.scope.all'),
          <Library className="size-4 shrink-0 opacity-60" aria-hidden="true" />,
        )}
        {item(
          'kb-scope-unfiled',
          { kind: 'unfiled' },
          t('workspace.knowledgeBase.scope.unfiled'),
          <Inbox className="size-4 shrink-0 opacity-60" aria-hidden="true" />,
        )}
      </ul>
      {folders.length > 0 ? (
        <>
          <p className="mb-1 mt-4 px-2 text-[11px] font-medium text-[color:var(--ws-ink-mute)]">
            {t('workspace.knowledgeBase.scope.folders')}
          </p>
          <ul className="flex flex-col gap-0.5">
            {folders.map((folder) =>
              item(
                `kb-scope-folder-${folder.id}`,
                { kind: 'folder', folderId: folder.id },
                folder.name,
                <Folder className="size-4 shrink-0 opacity-60" aria-hidden="true" />,
                folder.materialCount,
              ),
            )}
          </ul>
        </>
      ) : null}
    </nav>
  );
}

function folderLabel(material: LibraryMaterial, t: Translate): string {
  return material.folderId === null
    ? t('workspace.knowledgeBase.scope.unfiled')
    : (material.folderName ?? '');
}

function MaterialCards({
  materials,
  showFolder,
  locale,
  t,
}: {
  readonly materials: readonly LibraryMaterial[];
  readonly showFolder: boolean;
  readonly locale: string;
  readonly t: Translate;
}) {
  return (
    <ul
      data-testid="kb-cards"
      className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3"
    >
      {materials.map((material) => (
        <li
          key={material.materialId}
          data-testid={`kb-material-${material.materialId}`}
          className="flex min-w-0 flex-col gap-2 rounded-xl border border-[color:var(--ws-line)] bg-[color:var(--ws-surface)] p-3"
        >
          <div className="flex min-w-0 items-start gap-2">
            <MaterialIcon mime={material.mime} />
            <span
              className="min-w-0 flex-1 break-words text-[13px] font-medium"
              title={material.name}
            >
              {material.name}
            </span>
          </div>
          <StatusLabel material={material} t={t} />
          <span className="text-[11px] text-[color:var(--ws-ink-mute)]">
            {formatMaterialBytes(material.bytes, locale)}
            {showFolder ? ` · ${folderLabel(material, t)}` : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}

function MaterialList({
  materials,
  locale,
  t,
}: {
  readonly materials: readonly LibraryMaterial[];
  readonly locale: string;
  readonly t: Translate;
}) {
  const date = (iso: string) => {
    const value = new Date(iso);
    if (Number.isNaN(value.getTime())) return '';
    try {
      return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(value);
    } catch {
      return value.toISOString().slice(0, 10);
    }
  };
  return (
    <div className="overflow-x-auto">
      <table
        data-testid="kb-list"
        className="w-full min-w-[560px] border-collapse text-left text-[13px]"
      >
        <thead className="text-[11px] text-[color:var(--ws-ink-mute)]">
          <tr className="border-b border-[color:var(--ws-line)]">
            <th className="py-2 pr-3 font-medium">{t('workspace.knowledgeBase.column.name')}</th>
            <th className="py-2 pr-3 font-medium">{t('workspace.knowledgeBase.column.status')}</th>
            <th className="py-2 pr-3 font-medium">{t('workspace.knowledgeBase.column.folder')}</th>
            <th className="py-2 pr-3 font-medium">{t('workspace.knowledgeBase.column.size')}</th>
            <th className="py-2 font-medium">{t('workspace.knowledgeBase.column.added')}</th>
          </tr>
        </thead>
        <tbody>
          {materials.map((material) => (
            <tr
              key={material.materialId}
              data-testid={`kb-material-${material.materialId}`}
              className="border-b border-[color:var(--ws-line-soft)] align-top"
            >
              <td className="py-2 pr-3">
                <span className="flex min-w-0 items-start gap-2">
                  <MaterialIcon mime={material.mime} />
                  <span className="min-w-0 break-words" title={material.name}>
                    {material.name}
                  </span>
                </span>
              </td>
              <td className="py-2 pr-3">
                <StatusLabel material={material} t={t} />
              </td>
              <td className="py-2 pr-3 text-[color:var(--ws-ink-soft)]">
                {folderLabel(material, t)}
              </td>
              <td className="whitespace-nowrap py-2 pr-3 text-[color:var(--ws-ink-soft)]">
                {formatMaterialBytes(material.bytes, locale)}
              </td>
              <td className="whitespace-nowrap py-2 text-[color:var(--ws-ink-soft)]">
                {date(material.createdAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MaterialLibraryPage() {
  const { t, locale } = useI18n();
  const [scope, setScope] = useState<LibraryScope>({ kind: 'all' });
  const [queryInput, setQueryInput] = useState('');
  const query = useDebounced(queryInput.trim(), QUERY_DEBOUNCE_MS);
  const [view, setView] = useState<'cards' | 'list'>('cards');
  const library = useMaterialLibrary({ scope, query });

  // The folder being looked at was deleted elsewhere. Refreshing never
  // navigates (RFC #1716 §7): say so, and let the teacher go back.
  const folderGone =
    scope.kind === 'folder' &&
    library.status === 'ready' &&
    !library.folders.some((folder) => folder.id === scope.folderId);

  const emptyKey = query
    ? 'workspace.knowledgeBase.empty.query'
    : scope.kind === 'folder'
      ? 'workspace.knowledgeBase.empty.folder'
      : scope.kind === 'unfiled'
        ? 'workspace.knowledgeBase.empty.unfiled'
        : null;

  return (
    <main
      data-testid="pro-workspace-library"
      aria-labelledby="pro-workspace-library-title"
      className="ws-canvas relative flex min-w-0 flex-1 flex-col overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-5 px-5 pb-16 pt-8 sm:px-8">
        <header className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 id="pro-workspace-library-title" className="mr-auto text-[20px] font-semibold">
              {t('workspace.knowledgeBase.title')}
            </h1>
            <label className="ws-find flex h-9 w-full items-center gap-2 rounded-lg px-3 sm:w-64">
              <Search className="size-4 shrink-0 opacity-50" aria-hidden="true" />
              <input
                data-testid="kb-search"
                type="search"
                value={queryInput}
                onChange={(event) => setQueryInput(event.target.value)}
                placeholder={t('workspace.knowledgeBase.search')}
                aria-label={t('workspace.knowledgeBase.search')}
                className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
              />
            </label>
            <div
              role="group"
              aria-label={t('workspace.knowledgeBase.view.aria')}
              className="flex items-center gap-0.5"
            >
              <button
                type="button"
                data-testid="kb-view-cards"
                aria-pressed={view === 'cards'}
                aria-label={t('workspace.knowledgeBase.view.cards')}
                title={t('workspace.knowledgeBase.view.cards')}
                onClick={() => setView('cards')}
                className={cn('ws-util-btn', view === 'cards' && 'ws-row-active')}
              >
                <LayoutGrid className="size-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                data-testid="kb-view-list"
                aria-pressed={view === 'list'}
                aria-label={t('workspace.knowledgeBase.view.list')}
                title={t('workspace.knowledgeBase.view.list')}
                onClick={() => setView('list')}
                className={cn('ws-util-btn', view === 'list' && 'ws-row-active')}
              >
                <List className="size-4" aria-hidden="true" />
              </button>
            </div>
          </div>
          {library.limits ? <LimitsLine limits={library.limits} locale={locale} t={t} /> : null}
        </header>

        <div className="flex flex-col gap-6 md:flex-row">
          <ScopeNav scope={scope} folders={library.folders} onSelect={setScope} t={t} />

          <section className="min-w-0 flex-1" aria-live="polite">
            {library.status === 'loading' ? (
              <p data-testid="kb-loading" className="text-[13px] text-[color:var(--ws-ink-mute)]">
                {t('workspace.knowledgeBase.loading')}
              </p>
            ) : folderGone ? (
              <div
                data-testid="kb-folder-gone"
                role="status"
                className="flex flex-col items-start gap-2"
              >
                <p className="text-[13px]">{t('workspace.knowledgeBase.folderGone.message')}</p>
                <button
                  type="button"
                  data-testid="kb-folder-gone-back"
                  onClick={() => setScope({ kind: 'all' })}
                  className="ws-quiet text-[13px] underline"
                >
                  {t('workspace.knowledgeBase.folderGone.back')}
                </button>
              </div>
            ) : library.status === 'error' ? (
              <div data-testid="kb-error" role="alert" className="flex flex-col items-start gap-2">
                <p className="text-[13px]">{t(materialLibraryErrorKey(library.error))}</p>
                <button
                  type="button"
                  data-testid="kb-retry"
                  onClick={library.reload}
                  className="ws-quiet text-[13px] underline"
                >
                  {t('workspace.knowledgeBase.retry')}
                </button>
              </div>
            ) : (
              <>
                {library.error ? (
                  <div
                    data-testid="kb-stale"
                    role="alert"
                    className="mb-3 flex flex-wrap items-center gap-2 text-[12px] text-[color:var(--ws-ink-soft)]"
                  >
                    <span>
                      {t(materialLibraryErrorKey(library.error))}
                      {' · '}
                      {t('workspace.knowledgeBase.error.stale')}
                    </span>
                    <button type="button" onClick={library.reload} className="ws-quiet underline">
                      {t('workspace.knowledgeBase.retry')}
                    </button>
                  </div>
                ) : null}
                {library.materials.length === 0 ? (
                  emptyKey ? (
                    <p
                      data-testid="kb-empty"
                      className="text-[13px] text-[color:var(--ws-ink-mute)]"
                    >
                      {t(emptyKey, { query })}
                    </p>
                  ) : (
                    <div data-testid="kb-onboarding" className="flex max-w-[520px] flex-col gap-2">
                      <h2 className="text-[15px] font-medium">
                        {t('workspace.knowledgeBase.empty.title')}
                      </h2>
                      <p className="text-[13px] leading-6 text-[color:var(--ws-ink-soft)]">
                        {t('workspace.knowledgeBase.empty.body')}
                      </p>
                    </div>
                  )
                ) : view === 'cards' ? (
                  <MaterialCards
                    materials={library.materials}
                    showFolder={scope.kind === 'all'}
                    locale={locale}
                    t={t}
                  />
                ) : (
                  <MaterialList materials={library.materials} locale={locale} t={t} />
                )}
                {library.hasMore ? (
                  <button
                    type="button"
                    data-testid="kb-load-more"
                    // One read of the list at a time: not while a refresh rereads it.
                    disabled={library.loadingMore || library.refreshing}
                    onClick={library.loadMore}
                    className="ws-quiet mt-4 text-[13px] underline disabled:opacity-60"
                  >
                    {library.loadingMore
                      ? t('workspace.knowledgeBase.loading')
                      : t('workspace.knowledgeBase.loadMore')}
                  </button>
                ) : null}
              </>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
