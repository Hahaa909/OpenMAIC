'use client';

/**
 * The knowledge base page (RFC #1716 §7): the material library, opened from
 * the foot of the rail, filling the main area. In the UI it is the Knowledge
 * base; code and APIs keep "material library" (§10).
 *
 * The shell mounts it only while `?view=library` is set and keeps the
 * conversation and classroom panes mounted, hidden, underneath it.
 *
 * One file-manager list (#1835 review): folders first, then the files in no
 * folder; a folder expands in place, one level deep, and pages on its own;
 * with a query, one flat list with each file's folder. A background refresh
 * keeps which folders are open (`useMaterialLibraryTree`). Three regions --
 * the header, the usage and the list -- and, below `md` where the rail is
 * gone, a compact header with the way back.
 *
 * Upload is ingest (§1): a file uploaded here becomes a source in no folder,
 * through the same request and admission as the composer's paperclip, but
 * without the composer's per-message cap -- that bounds one message's picks,
 * not the library, whose limits the server enforces.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  File,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  FolderPlus,
  Info,
  LoaderCircle,
  Search,
  Upload,
  X,
} from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { MaterialExtractionReasonCode } from '@/lib/types/material-extraction-failure';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils/cn';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  createLibraryFolder,
  deleteLibraryFolder,
  deleteLibraryMaterial,
  formatMaterialBytes,
  MATERIAL_NAME_MAX_LENGTH,
  materialLibraryErrorKey,
  materialLibraryWriteErrorKey,
  moveLibraryMaterials,
  renameLibraryFolder,
  renameLibraryMaterial,
  stagedMaterialOfView,
  type LibraryFolder,
  type LibraryLimits,
  type LibraryMaterial,
  type MaterialExtractionStatus,
} from '@/lib/workbench/material-library-client';
import {
  useMaterialLibraryTree,
  type LibraryNodeKey,
  type LibraryNodeView,
} from '@/lib/workbench/use-material-library-tree';
import { validateFolderName } from '@/lib/utils/folder-name-validation';
import {
  DeleteDialog,
  LibraryItemMenu,
  menuIcons,
  MoveDialog,
  NameDialog,
  type LibraryMenuItem,
} from './MaterialLibraryDialogs';
import { WORKBENCH_MATERIAL_ACCEPT } from '@/lib/workbench/material-upload-policy';
import {
  createMaterialUploadIdentityGate,
  retryMaterialUpload,
  scheduleMaterialUploadBatch,
  type MaterialUploadIdentityGate,
} from '@/lib/workbench/material-upload-scheduling';
import {
  uploadWorkbenchMaterial,
  WorkbenchMaterialUploadError,
  type WorkbenchMaterial,
} from '@/lib/workbench/session-store';

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

/** A day for the "Date" column: month and day this year, the year too otherwise. */
export function formatLibraryDate(value: number | string | undefined, locale: string): string {
  if (value === undefined || value === '') return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const thisYear = date.getFullYear() === new Date().getFullYear();
  try {
    return new Intl.DateTimeFormat(
      locale,
      thisYear
        ? { month: '2-digit', day: '2-digit' }
        : { year: 'numeric', month: '2-digit', day: '2-digit' },
    ).format(date);
  } catch {
    return date.toISOString().slice(thisYear ? 5 : 0, 10);
  }
}

const parsing = (status: MaterialExtractionStatus) => status === 'pending' || status === 'running';

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

const failureCopy: Record<MaterialExtractionReasonCode, { label: string; description: string }> = {
  storage_full: {
    label: 'workspace.knowledgeBase.failure.storage_full.label',
    description: 'workspace.knowledgeBase.failure.storage_full.description',
  },
  source_unavailable: {
    label: 'workspace.knowledgeBase.failure.source_unavailable.label',
    description: 'workspace.knowledgeBase.failure.source_unavailable.description',
  },
  service_unavailable: {
    label: 'workspace.knowledgeBase.failure.service_unavailable.label',
    description: 'workspace.knowledgeBase.failure.service_unavailable.description',
  },
  media_too_long: {
    label: 'workspace.knowledgeBase.failure.media_too_long.label',
    description: 'workspace.knowledgeBase.failure.media_too_long.description',
  },
  no_text_extracted: {
    label: 'workspace.knowledgeBase.failure.no_text_extracted.label',
    description: 'workspace.knowledgeBase.failure.no_text_extracted.description',
  },
  processing_interrupted: {
    label: 'workspace.knowledgeBase.failure.processing_interrupted.label',
    description: 'workspace.knowledgeBase.failure.processing_interrupted.description',
  },
};

/** Only known reasons get a user explanation; diagnostic text never enters the row. */
function StatusLabel({
  material,
  t,
  testId,
}: {
  readonly material: LibraryMaterial;
  readonly t: Translate;
  readonly testId?: string;
}) {
  const { status, reasonCode } = material.extraction;
  const failure = status === 'failed' && reasonCode ? failureCopy[reasonCode] : undefined;
  return (
    <span
      data-testid={testId}
      data-status={status}
      className={cn(
        'inline-flex items-center gap-1 text-[12px]',
        status === 'failed'
          ? 'text-[color:var(--ws-fail)]'
          : status === 'done'
            ? 'text-[color:var(--ws-ink-soft)]'
            : 'text-[color:var(--ws-ink-mute)]',
      )}
    >
      {parsing(status) ? (
        <LoaderCircle
          data-testid={testId ? `${testId}-spinner` : undefined}
          className="size-3 shrink-0 animate-spin"
          aria-hidden="true"
        />
      ) : null}
      {t(failure ? failure.label : extractionLabelKey(status))}
      {failure ? (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={t('workspace.knowledgeBase.failure.more', { reason: t(failure.label) })}
              className="inline-flex size-6 shrink-0 items-center justify-center rounded focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              <Info className="size-3.5" aria-hidden="true" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            aria-label={t(failure.label)}
            className="max-w-[calc(100vw-2rem)] text-sm"
            collisionPadding={16}
          >
            {t(failure.description)}
          </PopoverContent>
        </Popover>
      ) : null}
    </span>
  );
}

/** "Used 8.7 MB of 2 GB", its bar, and the file count. The pool quota is not shown. */
function Usage({
  limits,
  locale,
  t,
}: {
  readonly limits: LibraryLimits;
  readonly locale: string;
  readonly t: Translate;
}) {
  const share =
    limits.maxTotalBytes > 0
      ? Math.min(1, Math.max(0, limits.usedBytes / limits.maxTotalBytes))
      : 0;
  const used = t('workspace.knowledgeBase.usage.bytes', {
    used: formatMaterialBytes(limits.usedBytes, locale),
    max: formatMaterialBytes(limits.maxTotalBytes, locale),
  });
  return (
    <div
      data-testid="kb-usage"
      className="flex flex-col gap-2 text-[12px] text-[color:var(--ws-ink-soft)] sm:flex-row sm:items-center sm:gap-4"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="shrink-0">{used}</span>
        <div
          role="progressbar"
          aria-label={used}
          aria-valuemin={0}
          aria-valuemax={limits.maxTotalBytes}
          aria-valuenow={limits.usedBytes}
          data-testid="kb-usage-bar"
          className="h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-[color:var(--ws-tint-strong)] sm:max-w-64"
        >
          <div
            className="h-full rounded-full bg-[color:var(--ws-accent)]"
            style={{ width: `${share * 100}%` }}
          />
        </div>
      </div>
      <span data-testid="kb-usage-count" className="shrink-0">
        {t('workspace.knowledgeBase.usage.count', {
          count: limits.usedCount,
          maxCount: limits.maxCount,
        })}
      </span>
    </div>
  );
}

interface UploadEntry {
  readonly id: string;
  readonly name: string;
  /** Why it failed; absent while it is still uploading. */
  readonly error?: string;
}

/**
 * The page's own uploads: each file is a row until it is stored (then the
 * listing shows it) or fails (then the row says why, until dismissed). Either
 * way the list is read again once the file is done.
 * Uploads are not cancelled by leaving the page; their rows go with it.
 */
function useLibraryUploads(onUploaded: () => void) {
  const { t, locale } = useI18n();
  const [entries, setEntries] = useState<readonly UploadEntry[]>([]);
  const gate = useRef<MaterialUploadIdentityGate | null>(null);
  const sequence = useRef(0);

  const start = (files: readonly File[]) => {
    if (files.length === 0) return;
    // The first upload of a fresh identity waits for its cookie (see
    // `scheduleMaterialUploadBatch`), exactly as the composer's do.
    gate.current ??= createMaterialUploadIdentityGate();
    const jobs = files.map((file) => ({
      file,
      entry: { id: `upload-${(sequence.current += 1)}`, name: file.name },
    }));
    setEntries((current) => [...current, ...jobs.map((job) => job.entry)]);
    void scheduleMaterialUploadBatch(gate.current, jobs, async ({ file, entry }) => {
      try {
        await retryMaterialUpload(() => uploadWorkbenchMaterial(file));
        setEntries((current) => current.filter((item) => item.id !== entry.id));
        return true;
      } catch (error) {
        const message =
          error instanceof WorkbenchMaterialUploadError
            ? error.userMessage(t, locale)
            : error instanceof Error
              ? error.message
              : t('workbench.material.uploadFailed', { name: file.name });
        setEntries((current) =>
          current.map((item) => (item.id === entry.id ? { ...item, error: message } : item)),
        );
        return false;
      } finally {
        // Once per file, after its last attempt (the 503 retries are inside
        // `retryMaterialUpload`), whatever the answer: a failed answer can
        // still follow a stored file -- the publication committed, then the
        // reply was lost -- and only the listing can say which.
        onUploaded();
      }
    });
  };

  return {
    entries,
    pending: entries.some((entry) => entry.error === undefined),
    start,
    dismiss: (id: string) => setEntries((current) => current.filter((item) => item.id !== id)),
  };
}

/**
 * Rows share one grid once the list itself is wide enough -- a container
 * query, not the window: the rail and the page's padding take their share,
 * so a 768 px window leaves the list far narrower than `md` implies. Below it
 * a row is the name with the state, size and date under it, and the ⋯
 * beside. The menu is the last child either way, so each row has one. A
 * search has one column more, so it waits for a wider list.
 */
const LAYOUT = {
  tree: {
    row: 'flex min-w-0 items-start gap-2 px-3 py-2 @2xl:grid @2xl:items-center @2xl:gap-3',
    columns: '@2xl:grid-cols-[minmax(0,1fr)_9rem_5.5rem_5.5rem_2rem]',
    cell: 'hidden truncate text-[12px] text-[color:var(--ws-ink-soft)] @2xl:block',
    narrowOnly: '@2xl:hidden',
    wideOnly: 'hidden @2xl:block',
    menu: 'shrink-0 @2xl:flex @2xl:justify-end',
    nameSpan: '@2xl:col-span-3',
    header:
      'hidden border-b border-[color:var(--ws-line)] px-3 py-2 text-[11px] text-[color:var(--ws-ink-mute)] @2xl:grid @2xl:gap-3',
  },
  search: {
    row: 'flex min-w-0 items-start gap-2 px-3 py-2 @3xl:grid @3xl:items-center @3xl:gap-3',
    columns: '@3xl:grid-cols-[minmax(0,1fr)_9rem_9rem_5.5rem_5.5rem_2rem]',
    cell: 'hidden truncate text-[12px] text-[color:var(--ws-ink-soft)] @3xl:block',
    narrowOnly: '@3xl:hidden',
    wideOnly: 'hidden @3xl:block',
    menu: 'shrink-0 @3xl:flex @3xl:justify-end',
    nameSpan: '@3xl:col-span-3',
    header:
      'hidden border-b border-[color:var(--ws-line)] px-3 py-2 text-[11px] text-[color:var(--ws-ink-mute)] @3xl:grid @3xl:gap-3',
  },
} as const;

export function MaterialLibraryPage({
  onChatWithMaterial,
  onLeave,
}: {
  /** Start a conversation with this source staged (the shell decides where). */
  readonly onChatWithMaterial: (material: WorkbenchMaterial) => void;
  /** Leave the page for what it covers (the compact header's way back). */
  readonly onLeave: () => void;
}) {
  const { t, locale } = useI18n();
  const [queryInput, setQueryInput] = useState('');
  /** The query the list is read for: settled while typing, cleared at once. */
  const [query, setQuery] = useState('');
  useEffect(() => {
    const value = queryInput.trim();
    if (!value) return;
    const timer = setTimeout(() => setQuery(value), QUERY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [queryInput]);
  const changeQuery = (value: string) => {
    setQueryInput(value);
    if (!value.trim()) setQuery('');
  };

  const fileInput = useRef<HTMLInputElement>(null);
  // The page's own changes read the list again (§7) -- but only while the
  // page is still there: an upload or a write can answer after the teacher
  // left, and then there is nothing to refresh.
  const reloadIfMounted = useRef<() => void>(() => {});
  const uploads = useLibraryUploads(() => reloadIfMounted.current());
  const tree = useMaterialLibraryTree({ query, uploading: uploads.pending });
  useEffect(() => {
    reloadIfMounted.current = tree.reload;
    return () => {
      reloadIfMounted.current = () => {};
    };
  }, [tree.reload]);
  const limitsId = useId();

  // ── Focus ───────────────────────────────────────────────────────────
  // The control a dialog was opened from: the focus goes back to it when the
  // dialog closes, or to the heading once it is gone with its item -- at once
  // for a deletion, or when the list read after the change drops it (a source
  // moved out of an expanded folder, renamed out of the search).
  const opener = useRef<HTMLElement | null>(null);
  const returnedTo = useRef<HTMLElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const openFrom = (open: () => void) => (trigger: HTMLElement | null) => {
    opener.current = trigger;
    open();
  };
  const returnFocus = (event: Event) => {
    event.preventDefault();
    const target = opener.current;
    opener.current = null;
    if (target?.isConnected) {
      target.focus();
      returnedTo.current = target;
    } else {
      heading.current?.focus();
    }
  };
  /** The folder a name already names: pointed at, for a moment. */
  const [highlighted, setHighlighted] = useState<string | null>(null);
  useEffect(() => {
    if (!highlighted) return;
    const timer = setTimeout(() => setHighlighted(null), 2_500);
    return () => clearTimeout(timer);
  }, [highlighted]);
  /**
   * A folder to show once the list has it: one just created, or the one a
   * taken name names (perhaps made elsewhere, not listed here yet). It is
   * pointed at -- highlighted, for a duplicate -- when its row appears, and
   * the focus goes to it only if the teacher has not moved on meanwhile: the
   * focus is still on the new-folder row, or nowhere (the row just closed).
   */
  const reveal = useRef<{ readonly folderId: string | null; readonly highlight: boolean } | null>(
    null,
  );
  useEffect(() => {
    // Stop following this creation once focus leaves its row, even if that
    // other control later disappears and focus returns to the body.
    const movedOn = (event: FocusEvent) => {
      if (
        event.target instanceof Element &&
        !event.target.closest('[data-testid="kb-new-folder-row"]')
      ) {
        reveal.current = null;
      }
    };
    document.addEventListener('focusin', movedOn);
    return () => {
      document.removeEventListener('focusin', movedOn);
      reveal.current = null;
    };
  }, []);
  const folderToggle = (folderId: string) =>
    list.current?.querySelector<HTMLElement>(`[data-testid="kb-folder-toggle-${folderId}"]`) ??
    null;
  const focusIsFree = () => {
    const active = document.activeElement;
    return (
      active === null ||
      active === document.body ||
      (active instanceof Element && active.closest('[data-testid="kb-new-folder-row"]') !== null)
    );
  };
  const revealArrived = () => {
    const pending = reveal.current;
    if (!pending || !pending.folderId) return;
    if (!focusIsFree()) {
      // The teacher went elsewhere (typed a search, opened something): drop it.
      reveal.current = null;
      return;
    }
    const toggle = folderToggle(pending.folderId);
    if (!toggle) return;
    reveal.current = null;
    if (pending.highlight) setHighlighted(pending.folderId);
    toggle.scrollIntoView?.({ block: 'nearest' });
    toggle.focus();
  };
  useEffect(() => {
    revealArrived();
    const target = returnedTo.current;
    if (!target) return;
    if (target.isConnected) {
      // The teacher moved on: stop following it.
      if (document.activeElement !== target) returnedTo.current = null;
      return;
    }
    returnedTo.current = null;
    if (document.activeElement === null || document.activeElement === document.body) {
      heading.current?.focus();
    }
  });

  // ── Scroll position ─────────────────────────────────────────────────
  // A refresh that adds or drops rows above the viewport must not move what
  // the teacher is looking at. Native scroll anchoring differs across engines,
  // so the page anchors by hand and turns the native one off:
  // the first row in view is remembered with its offset, and after each
  // render the scroll moves by however far that row went.
  const scroller = useRef<HTMLElement>(null);
  const scrollAnchor = useRef<{ readonly row: Element; readonly top: number } | null>(null);
  const rememberScrollAnchor = () => {
    const main = scroller.current;
    const rows = list.current;
    if (!main || !rows || main.scrollTop <= 0) {
      // At the very top there is nothing to hold: new rows above show.
      scrollAnchor.current = null;
      return;
    }
    const viewTop = main.getBoundingClientRect().top;
    for (const row of rows.querySelectorAll('[data-kb-row]')) {
      const box = row.getBoundingClientRect();
      if (box.bottom > viewTop) {
        scrollAnchor.current = { row, top: box.top - viewTop };
        return;
      }
    }
    scrollAnchor.current = null;
  };
  useEffect(() => {
    const main = scroller.current;
    if (!main) return;
    main.addEventListener('scroll', rememberScrollAnchor, { passive: true });
    return () => main.removeEventListener('scroll', rememberScrollAnchor);
    // The listener reads refs only.
  }, []);
  useLayoutEffect(() => {
    const main = scroller.current;
    const held = scrollAnchor.current;
    if (main && held?.row.isConnected) {
      const moved =
        held.row.getBoundingClientRect().top - main.getBoundingClientRect().top - held.top;
      if (moved !== 0) main.scrollTop += moved;
    }
    rememberScrollAnchor();
  });

  // ── New folder, in a row of the list ────────────────────────────────
  const newFolderButton = useRef<HTMLButtonElement>(null);
  const [creating, setCreating] = useState<{
    readonly name: string;
    readonly error: string | null;
    readonly busy: boolean;
  } | null>(null);
  const startCreating = () => {
    // One creation at a time: the row is busy until the server answers.
    if (creating?.busy) return;
    reveal.current = null;
    // A folder goes into the tree: leave a search for it, by the teacher's hand.
    changeQuery('');
    setCreating({ name: '', error: null, busy: false });
  };
  const cancelCreating = () => {
    reveal.current = null;
    setCreating(null);
    newFolderButton.current?.focus();
  };
  const checkFolderName = (name: string) => {
    const checked = validateFolderName(name);
    if (checked.ok) return null;
    return checked.kind === 'empty'
      ? 'workspace.knowledgeBase.error.folderNameEmpty'
      : 'workspace.knowledgeBase.error.folderNameTooLong';
  };
  const submitCreating = async () => {
    if (!creating || creating.busy) return;
    const hint = checkFolderName(creating.name);
    if (hint) {
      setCreating({ ...creating, error: hint });
      return;
    }
    reveal.current = { folderId: null, highlight: false };
    setCreating({ ...creating, busy: true, error: null });
    try {
      const { folderId, created } = await createLibraryFolder(creating.name.trim());
      if (created) {
        setCreating(null);
        if (reveal.current) reveal.current = { folderId, highlight: false };
      } else {
        // That name is taken: show the folder it names, and keep the row.
        setCreating(
          (current) =>
            current && {
              ...current,
              busy: false,
              error: 'workspace.knowledgeBase.error.nameTaken',
            },
        );
        if (reveal.current) reveal.current = { folderId, highlight: true };
        revealArrived();
      }
    } catch (error) {
      reveal.current = null;
      setCreating(
        (current) =>
          current && { ...current, busy: false, error: materialLibraryWriteErrorKey(error) },
      );
    } finally {
      reloadIfMounted.current();
    }
  };

  // ── Organizing (RFC #1716 §5) ───────────────────────────────────────
  type NameRequest =
    | { readonly kind: 'renameMaterial'; readonly material: LibraryMaterial }
    | { readonly kind: 'renameFolder'; readonly folder: LibraryFolder };
  const [naming, setNaming] = useState<NameRequest | null>(null);
  const [moving, setMoving] = useState<LibraryMaterial | null>(null);
  // Deletion is page-only, after confirmation (RFC #1716 §5, §4).
  type DeleteRequest =
    | { readonly kind: 'material'; readonly material: LibraryMaterial }
    | { readonly kind: 'folder'; readonly folder: LibraryFolder };
  const [deleting, setDeleting] = useState<DeleteRequest | null>(null);

  /** One write; the list is read again whatever it answered (§7). */
  const write = async (action: () => Promise<void>): Promise<string | null> => {
    try {
      await action();
      return null;
    } catch (error) {
      return materialLibraryWriteErrorKey(error);
    } finally {
      reloadIfMounted.current();
    }
  };
  const checkMaterialName = (name: string) => {
    const trimmed = name.trim();
    return trimmed.length === 0 || trimmed.length > MATERIAL_NAME_MAX_LENGTH
      ? 'workspace.knowledgeBase.error.invalidName'
      : null;
  };
  const submitName = (name: string) => {
    if (!naming) return Promise.resolve(null);
    if (naming.kind === 'renameMaterial') {
      return write(() => renameLibraryMaterial(naming.material.materialId, name));
    }
    return write(() => renameLibraryFolder(naming.folder.id, name));
  };

  const materialMenu = (material: LibraryMaterial) => {
    const items: LibraryMenuItem[] = [
      {
        // Inline types open in the tab; everything else downloads (the
        // route's headers decide, RFC #1716: "opens in a new tab or downloads").
        id: 'open',
        label: t('workspace.knowledgeBase.actions.open'),
        icon: menuIcons.open,
        href: `/api/materials/${encodeURIComponent(material.materialId)}/original`,
        onSelect: () => {},
      },
      {
        id: 'chat',
        label: t('workspace.knowledgeBase.actions.chat'),
        icon: menuIcons.chat,
        onSelect: () => onChatWithMaterial(stagedMaterialOfView(material)),
      },
      {
        id: 'rename',
        label: t('workspace.knowledgeBase.actions.rename'),
        icon: menuIcons.rename,
        onSelect: openFrom(() => setNaming({ kind: 'renameMaterial', material })),
      },
      {
        id: 'move',
        label: t('workspace.knowledgeBase.actions.move'),
        icon: menuIcons.move,
        onSelect: openFrom(() => setMoving(material)),
      },
      {
        id: 'delete',
        label: t('workspace.knowledgeBase.actions.delete'),
        icon: menuIcons.delete,
        destructive: true,
        onSelect: openFrom(() => setDeleting({ kind: 'material', material })),
      },
    ];
    return (
      <LibraryItemMenu
        testId={`kb-material-menu-${material.materialId}`}
        label={t('workspace.knowledgeBase.actions.more', { name: material.name })}
        items={items}
      />
    );
  };
  const folderMenu = (folder: LibraryFolder) => (
    <LibraryItemMenu
      testId={`kb-folder-menu-${folder.id}`}
      label={t('workspace.knowledgeBase.actions.more', { name: folder.name })}
      items={[
        {
          id: 'rename',
          label: t('workspace.knowledgeBase.actions.rename'),
          icon: menuIcons.rename,
          onSelect: openFrom(() => setNaming({ kind: 'renameFolder', folder })),
        },
        // Only an empty folder can go (the server still decides).
        ...(folder.materialCount === 0
          ? [
              {
                id: 'delete',
                label: t('workspace.knowledgeBase.actions.delete'),
                icon: menuIcons.delete,
                destructive: true,
                onSelect: openFrom(() => setDeleting({ kind: 'folder', folder })),
              },
            ]
          : []),
      ]}
    />
  );

  // ── Rows ────────────────────────────────────────────────────────────
  const folderName = (material: LibraryMaterial) =>
    material.folderId === null
      ? t('workspace.knowledgeBase.scope.unfiled')
      : (material.folderName ?? '');

  const fileRow = (material: LibraryMaterial, options: { nested?: boolean; search?: boolean }) => {
    const layout = options.search ? LAYOUT.search : LAYOUT.tree;
    const size = formatMaterialBytes(material.bytes, locale);
    const date = formatLibraryDate(material.createdAt, locale);
    return (
      <li
        key={material.materialId}
        data-testid={`kb-material-${material.materialId}`}
        data-kb-row=""
        className={cn(layout.row, layout.columns)}
      >
        <div className={cn('flex min-w-0 flex-1 items-start gap-2', options.nested && 'pl-6')}>
          <MaterialIcon mime={material.mime} />
          <div className="min-w-0 flex-1">
            <span className="block break-words text-[13px]" title={material.name}>
              {material.name}
            </span>
            <span
              className={cn(
                'mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[color:var(--ws-ink-mute)]',
                layout.narrowOnly,
              )}
            >
              <StatusLabel material={material} t={t} />
              <span>{size}</span>
              {date ? <span>{date}</span> : null}
              {options.search ? <span>{folderName(material)}</span> : null}
            </span>
          </div>
        </div>
        {options.search ? <span className={layout.cell}>{folderName(material)}</span> : null}
        <span className={layout.wideOnly}>
          <StatusLabel material={material} t={t} testId={`kb-status-${material.materialId}`} />
        </span>
        <span className={layout.cell}>{size}</span>
        <span className={layout.cell}>{date}</span>
        <span className={layout.menu}>{materialMenu(material)}</span>
      </li>
    );
  };

  const loadMoreRow = (
    node: LibraryNodeView,
    key: LibraryNodeKey,
    testId: string,
    nested = false,
  ) =>
    node.hasMore ? (
      <li className={cn('px-3 py-2', nested && 'pl-11')}>
        <button
          type="button"
          data-testid={testId}
          // One read of the list at a time: not while a refresh rereads it.
          disabled={node.loadingMore || tree.refreshing}
          onClick={() => tree.loadMore(key)}
          className="ws-quiet text-[13px] underline disabled:opacity-60"
        >
          {node.loadingMore
            ? t('workspace.knowledgeBase.loading')
            : t('workspace.knowledgeBase.loadMore')}
        </button>
      </li>
    ) : null;

  const folderRow = (folder: LibraryFolder) => {
    const node = tree.folder(folder.id);
    const open = node !== null;
    return (
      <li key={folder.id} data-testid={`kb-folder-${folder.id}`}>
        <div
          data-kb-row=""
          data-highlighted={highlighted === folder.id ? 'true' : undefined}
          className={cn(
            LAYOUT.tree.row,
            LAYOUT.tree.columns,
            'transition-colors',
            highlighted === folder.id && 'bg-[color:var(--ws-accent-wash)]',
          )}
        >
          {/* The toggle and the ⋯ are siblings: choosing from the menu never
              expands or collapses the folder. */}
          <button
            type="button"
            data-testid={`kb-folder-toggle-${folder.id}`}
            aria-expanded={open}
            onClick={() => (open ? tree.collapse(folder.id) : tree.expand(folder.id))}
            className={cn(
              'flex min-w-0 flex-1 items-start gap-2 rounded-md text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ws-accent)]',
              LAYOUT.tree.nameSpan,
            )}
          >
            {open ? (
              <ChevronDown className="mt-0.5 size-3.5 shrink-0 opacity-60" aria-hidden="true" />
            ) : (
              <ChevronRight className="mt-0.5 size-3.5 shrink-0 opacity-60" aria-hidden="true" />
            )}
            <Folder
              className="size-4 shrink-0 text-[color:var(--ws-ink-mute)]"
              aria-hidden="true"
            />
            <span className="min-w-0 break-words font-medium">{folder.name}</span>
            <span className="shrink-0 text-[11px] text-[color:var(--ws-ink-mute)]">
              ({folder.materialCount})
            </span>
          </button>
          <span className={LAYOUT.tree.cell}>{formatLibraryDate(folder.updatedAt, locale)}</span>
          <span className={LAYOUT.tree.menu}>{folderMenu(folder)}</span>
        </div>
        {node ? (
          <ul data-testid={`kb-folder-files-${folder.id}`}>
            {node.status === 'loading' ? (
              <li className="py-2 pl-11 text-[12px] text-[color:var(--ws-ink-mute)]">
                {t('workspace.knowledgeBase.loading')}
              </li>
            ) : node.status === 'error' ? (
              <li className="flex items-center gap-2 py-2 pl-11 text-[12px]" role="alert">
                <span>{t(materialLibraryErrorKey(node.error))}</span>
                <button type="button" onClick={tree.reload} className="ws-quiet underline">
                  {t('workspace.knowledgeBase.retry')}
                </button>
              </li>
            ) : node.files.length === 0 ? (
              <li
                data-testid={`kb-folder-empty-${folder.id}`}
                className="py-2 pl-11 text-[12px] text-[color:var(--ws-ink-mute)]"
              >
                {t('workspace.knowledgeBase.empty.folder')}
              </li>
            ) : (
              node.files.map((material) => fileRow(material, { nested: true }))
            )}
            {loadMoreRow(node, { folderId: folder.id }, `kb-load-more-${folder.id}`, true)}
          </ul>
        ) : null}
      </li>
    );
  };

  const uploadRows = uploads.entries.map((entry) => (
    <li
      key={entry.id}
      data-testid={`kb-${entry.id}`}
      className="flex min-w-0 items-start gap-2 px-3 py-2 text-[13px]"
    >
      {entry.error === undefined ? (
        <LoaderCircle
          className="mt-0.5 size-4 shrink-0 animate-spin opacity-60"
          aria-hidden="true"
        />
      ) : (
        <X className="mt-0.5 size-4 shrink-0 text-[color:var(--ws-fail)]" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1 break-words">
        {entry.name}
        {' · '}
        {entry.error === undefined ? (
          <span className="text-[color:var(--ws-ink-mute)]">
            {t('workspace.knowledgeBase.status.uploading')}
          </span>
        ) : (
          <span className="text-[color:var(--ws-fail)]">{entry.error}</span>
        )}
      </span>
      {entry.error !== undefined ? (
        <button
          type="button"
          data-testid={`kb-${entry.id}-dismiss`}
          onClick={() => uploads.dismiss(entry.id)}
          className="ws-quiet shrink-0 text-[12px] underline"
        >
          {t('workspace.knowledgeBase.upload.dismiss')}
        </button>
      ) : null}
    </li>
  ));

  const creatingRow = creating ? (
    <li data-testid="kb-new-folder-row" className="px-3 py-2">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submitCreating();
        }}
        className="flex flex-wrap items-center gap-2"
      >
        <FolderPlus
          className="size-4 shrink-0 text-[color:var(--ws-ink-mute)]"
          aria-hidden="true"
        />
        <input
          autoFocus
          data-testid="kb-new-folder-input"
          aria-label={t('workspace.knowledgeBase.folder.new')}
          aria-invalid={creating.error ? true : undefined}
          placeholder={t('workspace.knowledgeBase.dialog.name')}
          value={creating.name}
          disabled={creating.busy}
          onChange={(event) => setCreating({ ...creating, name: event.target.value, error: null })}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              cancelCreating();
            }
          }}
          className="h-8 min-w-0 flex-1 rounded-md border border-[color:var(--ws-line)] bg-transparent px-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ws-accent)] sm:max-w-80"
        />
        <button
          type="submit"
          data-testid="kb-new-folder-submit"
          disabled={creating.busy}
          className="ws-new h-8 rounded-md px-3 text-[12px] font-medium disabled:opacity-60"
        >
          {t('workspace.knowledgeBase.dialog.create')}
        </button>
        <button
          type="button"
          data-testid="kb-new-folder-cancel"
          disabled={creating.busy}
          onClick={cancelCreating}
          className="ws-quiet h-8 px-2 text-[12px] underline disabled:opacity-60"
        >
          {t('workspace.knowledgeBase.dialog.cancel')}
        </button>
      </form>
      {creating.error ? (
        <p
          data-testid="kb-new-folder-error"
          role="alert"
          className="mt-1 pl-6 text-[12px] text-[color:var(--ws-fail)]"
        >
          {t(creating.error)}
        </p>
      ) : null}
    </li>
  ) : null;

  // ── What the list region holds ──────────────────────────────────────
  const searching = tree.mode === 'search';
  const primary = searching ? tree.results : tree.root;
  const nothingAtAll =
    !searching &&
    tree.root.status === 'ready' &&
    tree.folders.length === 0 &&
    tree.root.files.length === 0 &&
    uploads.entries.length === 0 &&
    !creating;

  let body: ReactNode;
  if (primary.status === 'loading' && primary.files.length === 0) {
    body = (
      <p data-testid="kb-loading" className="px-3 py-3 text-[13px] text-[color:var(--ws-ink-mute)]">
        {t('workspace.knowledgeBase.loading')}
      </p>
    );
  } else if (primary.status === 'error') {
    body = (
      <div
        data-testid="kb-error"
        role="alert"
        className="flex flex-col items-start gap-2 px-3 py-3"
      >
        <p className="text-[13px]">{t(materialLibraryErrorKey(primary.error))}</p>
        <button
          type="button"
          data-testid="kb-retry"
          onClick={tree.reload}
          className="ws-quiet text-[13px] underline"
        >
          {t('workspace.knowledgeBase.retry')}
        </button>
      </div>
    );
  } else if (nothingAtAll) {
    body = (
      <div data-testid="kb-onboarding" className="flex max-w-[520px] flex-col gap-2 px-3 py-4">
        <h2 className="text-[15px] font-medium">{t('workspace.knowledgeBase.empty.title')}</h2>
        <p className="text-[13px] leading-6 text-[color:var(--ws-ink-soft)]">
          {t('workspace.knowledgeBase.empty.body')}
        </p>
      </div>
    );
  } else if (searching) {
    body = (
      <>
        <ListHeader search t={t} />
        <ul data-testid="kb-results">
          {uploadRows}
          {tree.results.files.length === 0 ? (
            <li
              data-testid="kb-empty"
              className="px-3 py-3 text-[13px] text-[color:var(--ws-ink-mute)]"
            >
              {t('workspace.knowledgeBase.empty.query', { query })}
            </li>
          ) : (
            tree.results.files.map((material) => fileRow(material, { search: true }))
          )}
          {loadMoreRow(tree.results, 'results', 'kb-load-more')}
        </ul>
      </>
    );
  } else {
    body = (
      <>
        <ListHeader t={t} />
        <ul data-testid="kb-tree">
          {creatingRow}
          {tree.folders.map(folderRow)}
          {uploadRows}
          {tree.root.files.map((material) => fileRow(material, {}))}
          {loadMoreRow(tree.root, 'root', 'kb-load-more')}
        </ul>
      </>
    );
  }

  const perFileLimits = tree.limits
    ? t('workspace.knowledgeBase.limits.perFile', {
        document: formatMaterialBytes(tree.limits.documentMaxBytes, locale),
        media: formatMaterialBytes(tree.limits.mediaMaxBytes, locale),
      })
    : null;
  const uploadButton = (
    <button
      type="button"
      data-testid="kb-upload"
      onClick={() => fileInput.current?.click()}
      aria-describedby={perFileLimits ? limitsId : undefined}
      className="ws-new flex h-9 items-center gap-2 rounded-lg px-3 text-[13px] font-medium"
    >
      <Upload className="size-4 shrink-0 opacity-60" aria-hidden="true" />
      {t('workspace.knowledgeBase.upload.button')}
    </button>
  );

  return (
    <main
      ref={scroller}
      data-testid="pro-workspace-library"
      aria-labelledby="pro-workspace-library-title"
      className="ws-canvas relative flex min-w-0 flex-1 flex-col overflow-y-auto [overflow-anchor:none]"
    >
      {/* Below `md` the rail is gone, so the page carries its own way out. */}
      <div className="flex h-12 shrink-0 items-center px-4 md:hidden">
        <button
          type="button"
          data-testid="kb-back"
          onClick={onLeave}
          className="ws-quiet inline-flex h-8 items-center gap-1.5 text-[13px]"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          {t('workspace.knowledgeBase.back')}
        </button>
      </div>

      <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-4 px-4 pb-16 pt-2 sm:px-8 md:pt-8">
        <header
          data-testid="kb-header"
          className="flex flex-col gap-3 border-b border-[color:var(--ws-line)] pb-4"
        >
          <div className="flex flex-wrap items-center gap-3">
            <h1
              ref={heading}
              id="pro-workspace-library-title"
              tabIndex={-1}
              className="mr-auto text-[20px] font-semibold outline-none"
            >
              {t('workspace.knowledgeBase.title')}
            </h1>
            <label className="ws-find flex h-9 w-full items-center gap-2 rounded-lg px-3 sm:w-64">
              <Search className="size-4 shrink-0 opacity-50" aria-hidden="true" />
              <input
                data-testid="kb-search"
                type="search"
                value={queryInput}
                onChange={(event) => changeQuery(event.target.value)}
                placeholder={t('workspace.knowledgeBase.search')}
                aria-label={t('workspace.knowledgeBase.search')}
                className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
              />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <button
                ref={newFolderButton}
                type="button"
                data-testid="kb-folder-new"
                disabled={creating?.busy}
                onClick={startCreating}
                className="ws-quiet flex h-9 items-center gap-2 rounded-lg border border-[color:var(--ws-line)] px-3 text-[13px] disabled:opacity-60"
              >
                <FolderPlus className="size-4 shrink-0 opacity-60" aria-hidden="true" />
                {t('workspace.knowledgeBase.folder.new')}
              </button>
              {perFileLimits ? (
                <Tooltip>
                  <TooltipTrigger asChild>{uploadButton}</TooltipTrigger>
                  <TooltipContent className="hidden md:block">{perFileLimits}</TooltipContent>
                </Tooltip>
              ) : (
                uploadButton
              )}
              <input
                ref={fileInput}
                data-testid="kb-upload-input"
                type="file"
                multiple
                accept={WORKBENCH_MATERIAL_ACCEPT}
                className="hidden"
                onChange={(event) => {
                  uploads.start(Array.from(event.target.files ?? []));
                  // The same file can be chosen again after a failure.
                  event.target.value = '';
                }}
              />
            </div>
          </div>
          {/* Touch screens have no hover: below `md` the per-file limits are
              written out; above it they are the upload button's tooltip.
              Either way the button is described by them. */}
          {perFileLimits ? (
            <p
              id={limitsId}
              data-testid="kb-upload-limits"
              className="text-[12px] text-[color:var(--ws-ink-mute)] md:hidden"
            >
              {perFileLimits}
            </p>
          ) : null}
        </header>

        {tree.limits ? (
          <section className="border-b border-[color:var(--ws-line)] pb-4">
            <Usage limits={tree.limits} locale={locale} t={t} />
          </section>
        ) : null}

        <section aria-live="polite">
          {tree.error && primary.status === 'ready' ? (
            <div
              data-testid="kb-stale"
              role="alert"
              className="mb-3 flex flex-wrap items-center gap-2 text-[12px] text-[color:var(--ws-ink-soft)]"
            >
              <span>
                {t(materialLibraryErrorKey(tree.error))}
                {' · '}
                {t('workspace.knowledgeBase.error.stale')}
              </span>
              <button type="button" onClick={tree.reload} className="ws-quiet underline">
                {t('workspace.knowledgeBase.retry')}
              </button>
            </div>
          ) : null}
          <div
            ref={list}
            data-testid="kb-list"
            className="@container overflow-hidden rounded-xl border border-[color:var(--ws-line)] bg-[color:var(--ws-surface)]"
          >
            {body}
          </div>
        </section>
      </div>

      {naming ? (
        <NameDialog
          key={
            naming.kind === 'renameMaterial'
              ? `material-${naming.material.materialId}`
              : `folder-${naming.folder.id}`
          }
          testId="kb-name-dialog"
          title={t(
            naming.kind === 'renameFolder'
              ? 'workspace.knowledgeBase.dialog.renameFolderTitle'
              : 'workspace.knowledgeBase.dialog.renameMaterialTitle',
          )}
          submitLabel={t('workspace.knowledgeBase.dialog.save')}
          initialName={naming.kind === 'renameMaterial' ? naming.material.name : naming.folder.name}
          maxLength={naming.kind === 'renameMaterial' ? MATERIAL_NAME_MAX_LENGTH : undefined}
          check={naming.kind === 'renameMaterial' ? checkMaterialName : checkFolderName}
          submit={submitName}
          onClose={() => setNaming(null)}
          returnFocus={returnFocus}
          t={t}
        />
      ) : null}
      {deleting?.kind === 'material' ? (
        <DeleteDialog
          key={`material-${deleting.material.materialId}`}
          testId="kb-delete-dialog"
          title={t('workspace.knowledgeBase.delete.materialTitle', {
            name: deleting.material.name,
          })}
          lines={[
            t('workspace.knowledgeBase.delete.materialLinks'),
            t('workspace.knowledgeBase.delete.materialCourses'),
            t('workspace.knowledgeBase.delete.cannotUndo'),
          ]}
          remove={() => deleteLibraryMaterial(deleting.material.materialId)}
          onSettled={() => reloadIfMounted.current()}
          onDeleted={() => {
            opener.current = null;
          }}
          onClose={() => setDeleting(null)}
          returnFocus={returnFocus}
          t={t}
        />
      ) : deleting?.kind === 'folder' ? (
        <DeleteDialog
          key={`folder-${deleting.folder.id}`}
          testId="kb-delete-dialog"
          title={t('workspace.knowledgeBase.delete.folderTitle', { name: deleting.folder.name })}
          lines={[t('workspace.knowledgeBase.delete.folderOnlyEmpty')]}
          remove={() => deleteLibraryFolder(deleting.folder.id)}
          onSettled={() => reloadIfMounted.current()}
          onDeleted={() => {
            opener.current = null;
          }}
          onClose={() => setDeleting(null)}
          returnFocus={returnFocus}
          t={t}
        />
      ) : null}
      {moving ? (
        <MoveDialog
          key={moving.materialId}
          material={moving}
          folders={tree.folders}
          move={(folderId) => write(() => moveLibraryMaterials([moving.materialId], folderId))}
          onClose={() => setMoving(null)}
          returnFocus={returnFocus}
          t={t}
        />
      ) : null}
    </main>
  );
}

/** The column names, on a wide list (on a narrow one each row says what it is). */
function ListHeader({ search = false, t }: { readonly search?: boolean; readonly t: Translate }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        search ? LAYOUT.search.header : LAYOUT.tree.header,
        search ? LAYOUT.search.columns : LAYOUT.tree.columns,
      )}
    >
      <span>{t('workspace.knowledgeBase.column.name')}</span>
      {search ? <span>{t('workspace.knowledgeBase.column.folder')}</span> : null}
      <span>{t('workspace.knowledgeBase.column.status')}</span>
      <span>{t('workspace.knowledgeBase.column.size')}</span>
      <span>{t('workspace.knowledgeBase.column.date')}</span>
      <span />
    </div>
  );
}
