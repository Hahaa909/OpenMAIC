'use client';

/**
 * The knowledge base page's data: the scope's sources, the folders and the
 * limits, read together, newest first (RFC #1716 §5, §8).
 *
 * - **One answer at a time.** Every read aborts the one before it and only
 *   the latest may commit, so a slow answer for an earlier folder or query
 *   never paints over a newer one.
 * - **A failure is not an empty library.** A read that fails before anything
 *   was shown is an error state; one that fails over shown data keeps the
 *   data and reports the error beside it.
 * - **Load more, then refresh as many pages.** `loadMore` appends the next
 *   page. `reload` reads as many pages as are shown, each from the cursor the
 *   previous page of the SAME read returned, and replaces the list only when
 *   every page arrived. A new scope or query starts again from one page.
 * - **One read of the list at a time.** While a refresh runs, `loadMore`
 *   does nothing (the page disables it): a page read from the old cursor
 *   would not belong to the list the refresh brings. A refresh started while
 *   a page is loading supersedes it, and that page is dropped. So the list,
 *   its page count and its cursor always come from the same read.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchMaterialLibraryFolders,
  fetchMaterialLibraryPage,
  joinLibraryPages,
  type LibraryFolder,
  type LibraryLimits,
  type LibraryMaterial,
  type LibraryScope,
} from '@/lib/workbench/material-library-client';

export interface MaterialLibraryData {
  readonly materials: readonly LibraryMaterial[];
  readonly folders: readonly LibraryFolder[];
  readonly limits: LibraryLimits | null;
  /** `loading` and `error` only while nothing has been shown for this scope. */
  readonly status: 'loading' | 'ready' | 'error';
  /** Why the latest read failed, whether or not data is still shown. */
  readonly error: unknown;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  /** A read of the shown pages is running; `loadMore` waits for it. */
  readonly refreshing: boolean;
  /** Read the shown pages again. */
  readonly reload: () => void;
  /** Append the next page. */
  readonly loadMore: () => void;
}

interface Snapshot {
  readonly key: string;
  readonly materials: readonly LibraryMaterial[];
  readonly folders: readonly LibraryFolder[];
  readonly limits: LibraryLimits | null;
  readonly status: 'loading' | 'ready' | 'error';
  readonly error: unknown;
  readonly nextBefore: string | undefined;
  readonly loadingMore: boolean;
  readonly refreshing: boolean;
}

const scopeKey = (scope: LibraryScope, query: string) =>
  JSON.stringify([scope.kind, scope.kind === 'folder' ? scope.folderId : null, query.trim()]);

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

export function useMaterialLibrary(input: {
  readonly scope: LibraryScope;
  readonly query: string;
}): MaterialLibraryData {
  const key = scopeKey(input.scope, input.query);
  const request = useRef({ scope: input.scope, query: input.query, key });
  const [snapshot, setSnapshot] = useState<Snapshot>(() => ({
    key,
    materials: [],
    folders: [],
    limits: null,
    status: 'loading',
    error: null,
    nextBefore: undefined,
    loadingMore: false,
    refreshing: true,
  }));
  /** Bumped by every read; only the read holding the latest value commits. */
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  /** Which read of the list is running, if any: never both. */
  const inFlight = useRef<'refresh' | 'more' | null>(null);
  /** How many pages the list shows, which a refresh reads again. */
  const pages = useRef(1);
  const nextBefore = useRef<string | undefined>(undefined);

  const reload = useCallback(() => {
    const { scope, query, key: readKey } = request.current;
    const ticket = ++generation.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    // Supersedes a page still loading: its ticket is now stale.
    inFlight.current = 'refresh';
    setSnapshot((previous) =>
      previous.refreshing && !previous.loadingMore
        ? previous
        : { ...previous, refreshing: true, loadingMore: false },
    );
    const wanted = Math.max(1, pages.current);

    const readPages = async () => {
      const read: (readonly LibraryMaterial[])[] = [];
      let limits: LibraryLimits | undefined;
      let before: string | undefined;
      for (let index = 0; index < wanted; index += 1) {
        const page = await fetchMaterialLibraryPage({
          scope,
          query,
          ...(before ? { before } : {}),
          signal: abort.signal,
        });
        read.push(page.materials);
        if (index === 0) limits = page.limits;
        before = page.nextBefore;
        if (!before) break;
      }
      return { read, limits, nextBefore: before };
    };

    void Promise.all([fetchMaterialLibraryFolders(abort.signal), readPages()]).then(
      ([folders, result]) => {
        if (ticket !== generation.current) return;
        inFlight.current = null;
        pages.current = result.read.length;
        nextBefore.current = result.nextBefore;
        setSnapshot((previous) => ({
          key: readKey,
          materials: joinLibraryPages(result.read),
          folders,
          limits: result.limits ?? (previous.key === readKey ? previous.limits : null),
          status: 'ready',
          error: null,
          nextBefore: result.nextBefore,
          loadingMore: false,
          refreshing: false,
        }));
      },
      (error: unknown) => {
        if (ticket !== generation.current || isAbort(error)) return;
        inFlight.current = null;
        setSnapshot((previous) =>
          previous.key === readKey && previous.status === 'ready'
            ? { ...previous, error, loadingMore: false, refreshing: false }
            : {
                ...previous,
                key: readKey,
                status: 'error',
                error,
                loadingMore: false,
                refreshing: false,
              },
        );
      },
    );
  }, []);

  const loadMore = useCallback(() => {
    const before = nextBefore.current;
    // A refresh is rereading the list, or a page is already loading.
    if (!before || inFlight.current !== null) return;
    inFlight.current = 'more';
    const { scope, query, key: readKey } = request.current;
    const ticket = generation.current;
    const signal = controller.current?.signal;
    setSnapshot((previous) => ({ ...previous, loadingMore: true }));
    void fetchMaterialLibraryPage({ scope, query, before, ...(signal ? { signal } : {}) }).then(
      (page) => {
        // A read that started meanwhile (refresh, new scope) owns the list.
        if (ticket !== generation.current) return;
        inFlight.current = null;
        pages.current += 1;
        nextBefore.current = page.nextBefore;
        setSnapshot((previous) => ({
          ...previous,
          key: readKey,
          materials: joinLibraryPages([previous.materials, page.materials]),
          nextBefore: page.nextBefore,
          loadingMore: false,
          error: null,
        }));
      },
      (error: unknown) => {
        if (ticket !== generation.current || isAbort(error)) return;
        inFlight.current = null;
        setSnapshot((previous) => ({ ...previous, error, loadingMore: false }));
      },
    );
  }, []);

  // A new scope or query: one page, from the top.
  useEffect(() => {
    request.current = { scope: input.scope, query: input.query, key };
    pages.current = 1;
    nextBefore.current = undefined;
    reload();
    // `input.scope` is read through `key`, which names it by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reload]);

  useEffect(
    () => () => {
      generation.current += 1;
      inFlight.current = null;
      controller.current?.abort();
    },
    [],
  );

  return useMemo(() => {
    // Between a scope change and its first answer, nothing from the old
    // scope; the folders and the owner's limits are not per scope.
    const current = snapshot.key === key;
    return {
      materials: current ? snapshot.materials : [],
      folders: snapshot.folders,
      limits: snapshot.limits,
      status: current ? snapshot.status : 'loading',
      error: current ? snapshot.error : null,
      hasMore: current && snapshot.nextBefore !== undefined,
      loadingMore: current && snapshot.loadingMore,
      refreshing: !current || snapshot.refreshing,
      reload,
      loadMore,
    };
  }, [snapshot, key, reload, loadMore]);
}
