'use client';

/**
 * The knowledge base page's organizing controls (RFC #1716 §5): the ⋯ menus
 * on a source and on a folder, and the dialogs they open. Every action is
 * one of the shared operations' routes; the page reads the list again after
 * each, whatever the answer, and a refusal stays in its dialog in the
 * server's own terms, never as a success.
 */
import { useRef, useState, type ReactNode } from 'react';
import {
  ExternalLink,
  FolderInput,
  Inbox,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Folder,
  Trash2,
} from 'lucide-react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils/cn';
import {
  MaterialLibraryRequestError,
  type LibraryFolder,
  type LibraryMaterial,
} from '@/lib/workbench/material-library-client';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** One item of a ⋯ menu. */
export interface LibraryMenuItem {
  readonly id: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
  /** A link instead of an action: opened in a new tab. */
  readonly href?: string;
}

/** A ⋯ button and its menu, for a source or a folder. */
export function LibraryItemMenu({
  testId,
  label,
  items,
}: {
  readonly testId: string;
  /** What the menu is for, as the button announces it. */
  readonly label: string;
  readonly items: readonly LibraryMenuItem[];
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid={testId}
          aria-label={label}
          title={label}
          onClick={(event) => event.stopPropagation()}
          className="ws-util-btn inline-flex size-7 shrink-0 items-center justify-center rounded-md"
        >
          <MoreHorizontal className="size-4" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="pro-popover w-44">
        {items.map((item) =>
          item.href ? (
            <DropdownMenuItem key={item.id} asChild onSelect={item.onSelect}>
              <a
                data-testid={`${testId}-${item.id}`}
                href={item.href}
                target="_blank"
                rel="noopener noreferrer"
              >
                {item.icon}
                {item.label}
              </a>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              key={item.id}
              data-testid={`${testId}-${item.id}`}
              disabled={item.disabled}
              variant={item.destructive ? 'destructive' : 'default'}
              onSelect={item.onSelect}
            >
              {item.icon}
              {item.label}
            </DropdownMenuItem>
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const menuIcons = {
  rename: <Pencil className="size-3.5" aria-hidden="true" />,
  move: <FolderInput className="size-3.5" aria-hidden="true" />,
  delete: <Trash2 className="size-3.5" aria-hidden="true" />,
  open: <ExternalLink className="size-3.5" aria-hidden="true" />,
  chat: <MessageSquarePlus className="size-3.5" aria-hidden="true" />,
};

/**
 * Ask for a name: rename a source or a folder, or name a new folder.
 * `check` gives the early hint (the server stays the authority); `submit`
 * answers with the i18n key of a refusal, or `null` once it is done.
 * Mounted per request (the page keys it), so each one starts fresh.
 */
export function NameDialog({
  testId,
  title,
  submitLabel,
  initialName,
  maxLength,
  check,
  submit,
  onClose,
  t,
}: {
  readonly testId: string;
  readonly title: string;
  readonly submitLabel: string;
  readonly initialName: string;
  readonly maxLength?: number;
  readonly check: (name: string) => string | null;
  readonly submit: (name: string) => Promise<string | null>;
  readonly onClose: () => void;
  readonly t: Translate;
}) {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (busy) return;
    const hint = check(name);
    if (hint) {
      setError(hint);
      return;
    }
    setBusy(true);
    const refusal = await submit(name.trim());
    setBusy(false);
    if (refusal) setError(refusal);
    else onClose();
  };

  return (
    <Dialog open onOpenChange={(next) => (!next && !busy ? onClose() : undefined)}>
      <DialogContent data-testid={testId} aria-describedby={undefined} className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void confirm();
          }}
          className="flex flex-col gap-2"
        >
          <label className="text-[13px] text-muted-foreground" htmlFor={`${testId}-input`}>
            {t('workspace.knowledgeBase.dialog.name')}
          </label>
          <input
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            id={`${testId}-input`}
            data-testid={`${testId}-input`}
            value={name}
            maxLength={maxLength}
            aria-invalid={error ? true : undefined}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-[14px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
          {error ? (
            <p data-testid={`${testId}-error`} role="alert" className="text-[12px] text-red-600">
              {t(error)}
            </p>
          ) : null}
          <DialogFooter className="mt-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {t('workspace.knowledgeBase.dialog.cancel')}
            </Button>
            <Button type="submit" data-testid={`${testId}-submit`} disabled={busy}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Move one source to a folder or to Unfiled. The place it already is in is
 * not offered; `move` answers with the i18n key of a refusal, or `null`.
 * Mounted per request (the page keys it), so each one starts fresh.
 */
export function MoveDialog({
  material,
  folders,
  move,
  onClose,
  t,
}: {
  readonly material: LibraryMaterial;
  readonly folders: readonly LibraryFolder[];
  readonly move: (folderId: string | null) => Promise<string | null>;
  readonly onClose: () => void;
  readonly t: Translate;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const targets: { id: string | null; label: string; icon: ReactNode }[] = [
    ...(material.folderId !== null
      ? [
          {
            id: null,
            label: t('workspace.knowledgeBase.scope.unfiled'),
            icon: <Inbox className="size-4 shrink-0 opacity-60" aria-hidden="true" />,
          },
        ]
      : []),
    ...folders
      .filter((folder) => folder.id !== material.folderId)
      .map((folder) => ({
        id: folder.id,
        label: folder.name,
        icon: <Folder className="size-4 shrink-0 opacity-60" aria-hidden="true" />,
      })),
  ];

  const choose = async (folderId: string | null) => {
    if (busy) return;
    setBusy(true);
    const refusal = await move(folderId);
    setBusy(false);
    if (refusal) setError(refusal);
    else onClose();
  };

  return (
    <Dialog open onOpenChange={(next) => (!next && !busy ? onClose() : undefined)}>
      <DialogContent
        data-testid="kb-move-dialog"
        aria-describedby={undefined}
        className="sm:max-w-[400px]"
      >
        <DialogHeader>
          <DialogTitle>
            {t('workspace.knowledgeBase.dialog.moveTitle', { name: material.name })}
          </DialogTitle>
        </DialogHeader>
        {targets.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            {t('workspace.knowledgeBase.dialog.noFolders')}
          </p>
        ) : (
          <ul className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
            {targets.map((target) => (
              <li key={target.id ?? 'unfiled'}>
                <button
                  type="button"
                  data-testid={`kb-move-to-${target.id ?? 'unfiled'}`}
                  disabled={busy}
                  onClick={() => void choose(target.id)}
                  className={cn(
                    'flex h-9 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-accent disabled:opacity-50',
                  )}
                >
                  {target.icon}
                  <span className="min-w-0 flex-1 truncate">{target.label}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {error ? (
          <p data-testid="kb-move-dialog-error" role="alert" className="text-[12px] text-red-600">
            {t(error)}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * How one delete attempt ended.
 *
 * - `deleted`: a 204 -- or a 404 after an attempt that FAILED: the deletion
 *   can commit and its reply still be lost (a 500), and the retry then finds
 *   nothing left to delete (#1805 review, notes for the confirmation UI).
 * - `gone`: a 404 on the first attempt. It was already deleted, elsewhere;
 *   not something this dialog did, so it is not reported as done.
 * - `notEmpty`: the folder still holds materials. The server decides, not
 *   the count the page shows.
 * - `identity`: the sign-in changed (401/403).
 * - `retry`: anything else -- busy (503), a server error, no answer. The
 *   deletion may or may not have happened; trying again settles it.
 */
export type DeleteOutcome =
  | { readonly outcome: 'deleted' }
  | {
      readonly outcome: 'gone' | 'notEmpty' | 'identity' | 'retry';
      readonly messageKey: string;
    };

export function deleteOutcomeOf(error: unknown, failedBefore: boolean): DeleteOutcome {
  if (error === null) return { outcome: 'deleted' };
  if (error instanceof MaterialLibraryRequestError) {
    if (error.status === 404) {
      return failedBefore
        ? { outcome: 'deleted' }
        : { outcome: 'gone', messageKey: 'workspace.knowledgeBase.error.gone' };
    }
    if (error.reason === 'not_empty') {
      return { outcome: 'notEmpty', messageKey: 'workspace.knowledgeBase.error.notEmpty' };
    }
    if (error.status === 401 || error.status === 403) {
      return { outcome: 'identity', messageKey: 'workspace.knowledgeBase.error.identity' };
    }
    if (error.status === 503) {
      return { outcome: 'retry', messageKey: 'workspace.knowledgeBase.error.busy' };
    }
  }
  return { outcome: 'retry', messageKey: 'workspace.knowledgeBase.error.save' };
}

/**
 * Confirm a deletion, say what it means, and see it through: a failed
 * attempt keeps the dialog open with a retry; a final refusal says why and
 * leaves only "Close". `onSettled` runs after every attempt (the page reads
 * the list again); `onDeleted` only once the deletion is known to be done.
 * Mounted per request (the page keys it).
 */
export function DeleteDialog({
  testId,
  title,
  lines,
  remove,
  onSettled,
  onDeleted,
  onClose,
  t,
}: {
  readonly testId: string;
  readonly title: string;
  /** What the deletion means, one sentence per line. */
  readonly lines: readonly string[];
  readonly remove: () => Promise<void>;
  readonly onSettled: () => void;
  readonly onDeleted: () => void;
  readonly onClose: () => void;
  readonly t: Translate;
}) {
  const [phase, setPhase] = useState<
    | { readonly kind: 'confirm' | 'busy' }
    | { readonly kind: 'retry' | 'final'; readonly messageKey: string }
  >({ kind: 'confirm' });
  const failedBefore = useRef(false);

  const attempt = async () => {
    if (phase.kind === 'busy' || phase.kind === 'final') return;
    setPhase({ kind: 'busy' });
    let error: unknown = null;
    try {
      await remove();
    } catch (caught) {
      error = caught;
    }
    onSettled();
    const result = deleteOutcomeOf(error, failedBefore.current);
    if (result.outcome === 'deleted') {
      onDeleted();
      onClose();
      return;
    }
    if (result.outcome === 'retry') {
      failedBefore.current = true;
      setPhase({ kind: 'retry', messageKey: result.messageKey });
      return;
    }
    setPhase({ kind: 'final', messageKey: result.messageKey });
  };

  const busy = phase.kind === 'busy';
  return (
    <AlertDialog open onOpenChange={(next) => (!next && !busy ? onClose() : undefined)}>
      <AlertDialogContent data-testid={testId} className="sm:max-w-[420px]">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-1">
              {lines.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {phase.kind === 'retry' || phase.kind === 'final' ? (
          <p data-testid={`${testId}-message`} role="alert" className="text-[12px] text-red-600">
            {t(phase.messageKey)}
          </p>
        ) : null}
        <AlertDialogFooter>
          {/* Radix's own cancel: it takes the focus when the dialog opens, and
              closes through `onOpenChange` (refused while an attempt runs). */}
          <AlertDialogCancel data-testid={`${testId}-cancel`} disabled={busy}>
            {t(
              phase.kind === 'final'
                ? 'workspace.knowledgeBase.dialog.close'
                : 'workspace.knowledgeBase.dialog.cancel',
            )}
          </AlertDialogCancel>
          {phase.kind === 'final' ? null : (
            <Button
              type="button"
              variant="destructive"
              data-testid={`${testId}-confirm`}
              disabled={busy}
              onClick={() => void attempt()}
            >
              {t(
                phase.kind === 'retry'
                  ? 'workspace.knowledgeBase.retry'
                  : 'workspace.knowledgeBase.actions.delete',
              )}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
