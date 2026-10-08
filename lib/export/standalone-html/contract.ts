/**
 * Shared contract between the standalone HTML export (app side) and the
 * standalone player bundle (`lib/standalone-player`, built into
 * `public/vendor/standalone-player/` at build time).
 *
 * Dependency-free on purpose: the player bundle imports this module, so
 * anything added here ships inside every exported file.
 */

/** `<script type="application/json">` holding the {@link ClassroomManifest}. */
export const STANDALONE_MANIFEST_ELEMENT_ID = 'openmaic-classroom';

/** `<script type="application/json">` holding the {@link StandalonePlayerConfig}. */
export const STANDALONE_CONFIG_ELEMENT_ID = 'openmaic-player-config';

/**
 * `<script type="application/json">` holding the {@link StandaloneMediaTable}:
 * the playback media (narration audio, video clips) the actions and video
 * elements name by key. Absent in files exported without narration.
 */
export const STANDALONE_MEDIA_TABLE_ELEMENT_ID = 'openmaic-media';

/**
 * Element id prefix of the `<script type="application/octet-stream">` blocks
 * carrying embedded media bytes as base64. Data blocks are never executed, and
 * the player decodes one only when its media is first played, so a large
 * file does not hold every clip twice in memory.
 */
export const STANDALONE_MEDIA_BLOCK_ID_PREFIX = 'openmaic-media-';

/**
 * Where the bytes of one playback media key live. Exactly one of `embedded`
 * (the id of a base64 data block in this document) or `src` (a URL, e.g. a
 * relative path for an export that ships its media next to the page) is set.
 */
export interface StandaloneMediaEntry {
  mimeType?: string;
  embedded?: string;
  src?: string;
}

/** Playback media key (the archive path the manifest names) → its bytes. */
export type StandaloneMediaTable = Record<string, StandaloneMediaEntry>;

/**
 * Size above which the export warns about the file's size (it still saves).
 *
 * Opening is not the bottleneck: embedded media sits in data blocks the
 * browser keeps as plain text until a clip plays, and a 400 MB file opened
 * from disk reached the player in about 1.3 s in both desktop Chromium and
 * WebKit (100 MB: under 0.9 s). The limits are elsewhere: the exporting tab
 * holds the media, its base64 and the assembled document at once (roughly
 * three times the file size), a single JavaScript string cannot exceed about
 * 512 MiB in V8, mobile browsers evict tabs far earlier, and files this size
 * no longer fit mail or chat attachments. 100 MB keeps the export well clear
 * of the hard limits and flags the files that are awkward to share.
 */
export const STANDALONE_HTML_SIZE_WARNING_BYTES = 100 * 1024 * 1024;

/** Mount point of the player app. */
export const STANDALONE_ROOT_ELEMENT_ID = 'openmaic-player';

/**
 * Where the build step writes the player assets, relative to `public/`. The
 * export fetches them from the same origin and inlines them.
 */
export const STANDALONE_PLAYER_ASSET_DIR = 'vendor/standalone-player';
export const STANDALONE_PLAYER_ASSETS = {
  script: `${STANDALONE_PLAYER_ASSET_DIR}/player.min.js`,
  style: `${STANDALONE_PLAYER_ASSET_DIR}/player.min.css`,
  /** KaTeX @font-face rules with the woff2 files inlined; only shipped when math is present. */
  mathFonts: `${STANDALONE_PLAYER_ASSET_DIR}/katex-fonts.min.css`,
  /** The ECharts runtime for chart elements; only shipped when a slide has a chart. */
  charts: `${STANDALONE_PLAYER_ASSET_DIR}/player-charts.min.js`,
} as const;

/**
 * Global through which the optional charts script hands ECharts to the player.
 * The player bundle resolves the renderer's `echarts/*` imports to this
 * global (see `scripts/build-standalone-player.mjs`, which repeats the name),
 * so files without charts do not carry ECharts at all.
 */
export const STANDALONE_CHARTS_GLOBAL = '__OPENMAIC_CHARTS__';

/**
 * Sandbox flags for interactive scenes. Must stay identical to the classroom's
 * `InteractiveIframeHost`: scripts run, but never in the player's origin.
 */
export const STANDALONE_INTERACTIVE_SANDBOX = 'allow-scripts allow-forms allow-popups';

/** Every UI string the player shows, resolved from the app locale at export time. */
export const STANDALONE_PLAYER_STRING_KEYS = [
  'previous',
  'next',
  'scenes',
  'fullscreen',
  'exitFullscreen',
  'emptyClassroom',
  'unsupportedScene',
  'interactiveTitle',
  'videoUnavailable',
  'quizSubmit',
  'quizRetry',
  'quizScore',
  'quizCorrect',
  'quizIncorrect',
  'quizCorrectAnswer',
  'quizExplanation',
  'quizReferenceAnswer',
  'quizNoReferenceAnswer',
  'quizAnswerPlaceholder',
  'quizMultipleHint',
  'pblScenario',
  'pblGoal',
  'pblYourRole',
  'pblCharacters',
  'pblLearningObjective',
  'pblMilestones',
  'pblOnlineOnly',
  'pblContinueOnline',
] as const;

export type StandalonePlayerStringKey = (typeof STANDALONE_PLAYER_STRING_KEYS)[number];
export type StandalonePlayerStrings = Record<StandalonePlayerStringKey, string>;

export interface StandalonePlayerConfig {
  strings: StandalonePlayerStrings;
  /**
   * Address of the online classroom, where PBL scenes link for the agent
   * workflow. Omitted when the exporting host provides none.
   */
  classroomUrl?: string;
}
