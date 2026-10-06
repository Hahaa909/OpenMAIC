import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readOwnerMaterialText } from '@/lib/server/materials/owner-material-text';

const state = vi.hoisted(() => ({
  inTransaction: false,
  read: vi.fn(),
  parse: vi.fn(),
  row: undefined as unknown,
}));
vi.mock('@/lib/persistence/owner-merges', () => ({
  forwardOwnerWrite: vi.fn(async () => 'user:alice'),
}));
vi.mock('@/lib/server/material-extraction/document-images', () => ({
  resolveDerivativeRefsAsync: state.parse,
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({
    assetStore: { resolve: async () => null },
    assetStoreIn: () => ({ resolve: state.read }),
    withTransaction: async (body: (tx: unknown) => Promise<unknown>) => {
      state.inTransaction = true;
      try {
        return await body({ query: async () => ({ rows: state.row ? [state.row] : [] }) });
      } finally {
        state.inTransaction = false;
      }
    },
  }),
}));
const result = {
  revision: 'new-revision',
  text: { assetId: 'text', chars: 1 },
  derivatives: [
    {
      id: 'own-image',
      key: 'img-1',
      kind: 'image' as const,
      assetId: 'image',
      title: 'Image',
      mime: 'image/webp',
      bytes: 1,
      sha256: 'image-sha',
    },
  ],
};
const location = { id: 'source', ownerId: 'anon:stale', extractionResult: result };

beforeEach(() => {
  state.read.mockReset();
  state.parse.mockReset();
  state.row = { owner_id: 'user:alice', deleted_at: null, extraction_result: result };
  state.read.mockResolvedValue({
    bytes: Buffer.from('![x](openmaic-derivative:img-1)'),
    revision: 7,
  });
});
afterEach(() => vi.restoreAllMocks());

it('commits the fenced byte read before awaiting legacy parsing', async () => {
  let entered!: () => void;
  const parsing = new Promise<void>((resolve) => (entered = resolve));
  let finish!: (text: string) => void;
  state.parse.mockImplementation(() => {
    entered();
    return new Promise<string>((resolve) => (finish = resolve));
  });
  const reading = readOwnerMaterialText(location);
  await parsing;
  try {
    expect(state.inTransaction).toBe(false);
    expect(state.parse).toHaveBeenCalledWith(
      '![x](openmaic-derivative:img-1)',
      result.derivatives,
      JSON.stringify(['user:alice', 'text', 'new-revision', 7]),
      undefined,
    );
  } finally {
    finish('![x](material:own-image)');
  }
  await expect(reading).resolves.toEqual({
    text: '![x](material:own-image)',
    revision: 'new-revision',
  });
});

it('still returns null when the fenced bytes or the parser fail', async () => {
  state.read.mockRejectedValueOnce(new Error('unavailable'));
  await expect(readOwnerMaterialText(location)).resolves.toBeNull();
  expect(state.parse).not.toHaveBeenCalled();
  state.parse.mockRejectedValueOnce(new Error('parser failed'));
  await expect(readOwnerMaterialText(location)).resolves.toBeNull();
  expect(state.inTransaction).toBe(false);
});

it('does not parse a tombstone found by the fenced re-read', async () => {
  state.row = { owner_id: 'user:alice', deleted_at: 1, extraction_result: result };
  await expect(readOwnerMaterialText(location)).resolves.toBeNull();
  expect(state.read).not.toHaveBeenCalled();
  expect(state.parse).not.toHaveBeenCalled();
});
