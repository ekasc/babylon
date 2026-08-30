// Snapcompact: Babylon-native context-archive projection.
//
// This module defines the data shapes used across the snapcompact pipeline.
// Snapcompact never mutates Pi's session file; the archive is a separate
// projection persisted under Babylon-owned state and re-built from the
// session file plus the latest projection boundaries.

/** Identifier for a single archive generation, scoped to a session. */
export interface SnapcompactSessionKey {
  sessionId: string;
  sessionFile: string;
}

/** One exact-token anchor in the symbol dictionary. */
export interface SnapcompactSymbol {
  /** Deterministic ID, stable within an archive generation (e.g. "E001"). */
  id: string;
  /** The exact string the rasterized transcript substituted away from. */
  value: string;
  /** Coarse category for the symbol (path, sha, identifier, ...). */
  kind: "path" | "sha" | "branch" | "url" | "version" | "command" | "env" | "port" | "identifier";
}

/** A single rasterized frame in the archive. */
export interface SnapcompactFrame {
  /** Monotonic index within the archive (0 = head, near recent). */
  index: number;
  /** Width / height in pixels, fixed by the model profile. */
  width: number;
  height: number;
  /** Raw PNG bytes. */
  png: Buffer;
  /** Character offset in `sourceText` this frame starts at. */
  sourceOffset: number;
  /** Character offset (exclusive) in `sourceText` this frame ends at. */
  sourceEnd: number;
}

/** Persisted archive state. Versioned; older versions are discarded. */
export interface SnapcompactArchive {
  version: 1;
  sessionId: string;
  /** Identifier of the session file (used as the storage key). */
  sessionFile: string;
  /** Strategy that produced this archive (for diagnostics). */
  strategy: "snapcompact";
  /** Canonical, normalized transcript text the archive was built from. */
  sourceText: string;
  /** Exact-token dictionary preserved as raw text. */
  symbols: SnapcompactSymbol[];
  /** Rasterized frames, in chronological order (oldest last). In-memory
   *  form holds the raw PNG bytes; the on-disk form stores a path per
   *  frame in a separate frames/ directory. */
  frames: SnapcompactFrame[];
  /** Last message entryId covered by this archive. */
  coveredThroughMessageId: string | null;
  /** Wall-clock creation time (ms since epoch). */
  createdAt: number;
  /** Wall-clock time of the underlying session's last activity (ms). */
  coveredThroughTimestamp: number | null;
  /** Rendered pixel dimensions (denormalized for diagnostics). */
  frameWidth: number;
  frameHeight: number;
  /** Profile id used to produce this archive. */
  profileId: string;
  /** Approximate number of bytes for the PNG frames on disk. */
  frameBytes: number;
}

/** Compaction strategy the runtime may select. */
export type CompactionStrategy = "summary" | "snapcompact";

/** User-selectable compaction mode. */
export type CompactionMode = "automatic" | CompactionStrategy;
