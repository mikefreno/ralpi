/**
 * Reusable unified-diff engine: parses a diff into per-file +/− stats and
 * filters out noise files (locks, build output, vendor, generated, media
 * binaries) so review prompts feed the model only clean, review-relevant
 * changes.
 *
 * Ported from @piex-dev/review's `EXCLUDED_PATTERNS` + `parseDiff` (MIT).
 * Kept the excluded-files-not-totaled behavior that fixed the upstream
 * double-count bug.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

/** Per-file diff stats. */
export interface FileDiff {
	/** File path as it appears in the diff (`a/` path). */
	path: string;
	/** Number of added lines (excluding the `+++` header). */
	linesAdded: number;
	/** Number of removed lines (excluding the `---` header). */
	linesRemoved: number;
	/** File extension (empty when the path has none). */
	ext: string;
}

/** An excluded (noise) file with the reason it was filtered. */
export interface ExcludedFile extends FileDiff {
	/** Why the file was excluded (e.g. "lockfile"). */
	reason: string;
}

/** Result of parsing a unified diff. */
export interface DiffSummary {
	/** Files kept in scope (review-relevant). */
	files: FileDiff[];
	/** Files filtered out as noise. */
	excluded: ExcludedFile[];
	/** Sum of added lines over included files only. */
	totalAdded: number;
	/** Sum of removed lines over included files only. */
	totalRemoved: number;
}

/** Caller-supplied overrides for the noise filter. */
export interface DiffOptions {
	/** Additional exclusion regexes merged into EXCLUDED_PATTERNS. */
	extraPatterns?: RegExp[];
	/** Pathspec allowlist — files matching these stay in scope even if a
	 *  default rule would exclude them. */
	ignorePaths?: string[];
}

// ─── Noise-Filter Rules ─────────────────────────────────────────────────────

/** Default noise-exclusion rules, ported from @piex-dev/review (MIT).
 *  Each entry is a regex tested against the file path plus a human-readable
 *  reason surfaced in the "Excluded Files" prompt section. */
export const EXCLUDED_PATTERNS: { pattern: RegExp; reason: string }[] = [
	// Lockfiles
	{ pattern: /(^|\/)package-lock\.json$/i, reason: "lockfile" },
	{ pattern: /(^|\/)yarn\.lock$/i, reason: "lockfile" },
	{ pattern: /(^|\/)pnpm-lock\.yaml$/i, reason: "lockfile" },
	{ pattern: /(^|\/)Cargo\.lock$/i, reason: "lockfile" },
	{ pattern: /(^|\/)Gemfile\.lock$/i, reason: "lockfile" },
	{ pattern: /\.lock$/i, reason: "lockfile" },
	// Minified assets
	{ pattern: /\.min\.(js|css)$/i, reason: "minified asset" },
	// Generated / tooling output
	{ pattern: /\.generated\./i, reason: "generated file" },
	{ pattern: /\.snap$/i, reason: "snapshot" },
	{ pattern: /\.map$/i, reason: "source map" },
	// Build output directories
	{ pattern: /(^|\/)(dist|build|out|coverage)\//i, reason: "build output" },
	// Dependency trees
	{ pattern: /(^|\/)node_modules\//i, reason: "dependency" },
	{ pattern: /(^|\/)vendor\//i, reason: "vendored dependency" },
	// Image / font / binary extensions
	{
		pattern:
			/\.(png|jpe?g|gif|webp|svg|ico|avif|bmp|woff2?|ttf|otf|eot|pdf|zip|tar|gz|mp[34]|wav|ogg|flac|wasm|bin|exe|dll|so|a|o|class|jar|pyc)$/i,
		reason: "binary/media asset",
	},
];

/**
 * Return the exclusion reason for a file path, or undefined when the file is
 * review-relevant. Extra caller-supplied patterns are merged into the default
 * rule set.
 */
export function isExcluded(
	fp: string,
	extraPatterns?: RegExp[],
): string | undefined {
	for (const rule of EXCLUDED_PATTERNS) {
		if (rule.pattern.test(fp)) return rule.reason;
	}
	if (extraPatterns) {
		for (const p of extraPatterns) {
			if (p.test(fp)) return "extra ignore pattern";
		}
	}
	return undefined;
}

/**
 * Safely compile user-supplied regex strings into RegExp objects. Invalid
 * patterns (that don't compile) are skipped so a bad config value never
 * crashes review prompt building.
 */
export function compileIgnorePatterns(patterns: string[]): RegExp[] {
	const out: RegExp[] = [];
	for (const p of patterns) {
		if (!p) continue;
		try {
			out.push(new RegExp(p));
		} catch {
			// Skip malformed patterns silently
		}
	}
	return out;
}

// ─── Chunking + Counting Helpers ────────────────────────────────────────────

/** Split a raw diff into per-file chunks, each starting at a `diff --git`
 *  line. The leading non-diff preamble (e.g. a `--stat` block) is dropped —
 *  per-file stats are derived from the patch chunks themselves. */
function chunkDiff(raw: string): string[] {
	if (!raw) return [];
	const lines = raw.split("\n");
	const chunks: string[] = [];
	let current: string[] = [];
	let started = false;
	for (const line of lines) {
		if (line.startsWith("diff --git ")) {
			if (started && current.length > 0) chunks.push(current.join("\n"));
			current = [line];
			started = true;
		} else if (started) {
			current.push(line);
		}
	}
	if (started && current.length > 0) chunks.push(current.join("\n"));
	return chunks;
}

/** Parse the `a/<path>` from a `diff --git a/… b/…` header. Returns null for
 *  malformed chunks that lack the a/… b/… header (guarded, never crashes). */
function chunkPath(chunk: string): string | null {
	const m = chunk.match(/^diff --git a\/(.+?) b\//);
	return m ? m[1] : null;
}

/** Count added/removed lines in a chunk, excluding the `+++`/`---` headers. */
function countLines(chunk: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of chunk.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) added++;
		else if (line.startsWith("-") && !line.startsWith("---")) removed++;
	}
	return { added, removed };
}

/** Extract the file extension from a path (no ext → empty string). */
function getExt(fp: string): string {
	const base = fp.split("/").pop() ?? "";
	const idx = base.lastIndexOf(".");
	return idx > 0 ? base.slice(idx + 1) : "";
}

/** Convert a git pathspec glob into a regex (supports `*`, `**`, `?`). */
function globToRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				re += ".*";
				i++;
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") {
			re += "[^/]";
		} else if (c === ".") {
			re += "\\.";
		} else {
			re += c;
		}
	}
	return new RegExp(`^${re}$`);
}

/** Whether a file path matches a pathspec allowlist entry. */
function matchesPathspec(pathspec: string, fp: string): boolean {
	const ps = pathspec.trim();
	if (!ps) return false;
	// Directory prefix: "tests/" or a bare dir name matches everything under it.
	if (ps.endsWith("/") && fp.startsWith(ps)) return true;
	if (ps.includes("*") || ps.includes("?")) return globToRegExp(ps).test(fp);
	// Plain path — exact file or prefix directory.
	if (fp === ps) return true;
	if (fp.startsWith(ps + "/")) return true;
	return false;
}

/** Decide whether a file path is kept in scope or noise-excluded. */
function classify(
	path: string,
	opts?: DiffOptions,
): { kept: boolean; reason?: string } {
	const reason = isExcluded(path, opts?.extraPatterns);
	if (reason === undefined) return { kept: true };
	// Excluded by a rule, but an ignorePaths allowlist can keep it in scope.
	const keptByPathspec =
		opts?.ignorePaths?.some((ps) => matchesPathspec(ps, path)) ?? false;
	return keptByPathspec ? { kept: true } : { kept: false, reason };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Parse a unified diff into per-file +/− stats, splitting excluded (noise)
 * files from included files. Totals are summed over included files only.
 * Malformed chunks (no a/… b/… header) are skipped without crashing.
 */
export function parseDiff(raw: string, opts?: DiffOptions): DiffSummary {
	const files: FileDiff[] = [];
	const excluded: ExcludedFile[] = [];
	let totalAdded = 0;
	let totalRemoved = 0;

	for (const chunk of chunkDiff(raw)) {
		if (!chunk) continue;
		const path = chunkPath(chunk);
		if (path === null) continue; // malformed chunk — skip
		const { added, removed } = countLines(chunk);
		const base: FileDiff = {
			path,
			linesAdded: added,
			linesRemoved: removed,
			ext: getExt(path),
		};
		const decision = classify(path, opts);
		if (decision.kept) {
			files.push(base);
			totalAdded += added;
			totalRemoved += removed;
		} else if (decision.reason) {
			excluded.push({ ...base, reason: decision.reason });
		}
	}

	return { files, excluded, totalAdded, totalRemoved };
}

/**
 * Return the diff re-emitted with excluded (noise) file chunks removed, so an
 * inlined review diff never contains filtered content. The stat preamble is
 * dropped — the per-file summary table carries that information. Empty string
 * when every changed file is noise.
 */
export function filterNoise(raw: string, opts?: DiffOptions): string {
	const kept: string[] = [];
	for (const chunk of chunkDiff(raw)) {
		if (!chunk) continue;
		const path = chunkPath(chunk);
		if (path === null) continue;
		const decision = classify(path, opts);
		if (decision.kept) kept.push(chunk);
	}
	return kept.join("\n");
}
