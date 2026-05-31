import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Batches widget updates from multiple parallel tasks into a single
 * render cycle, preventing TUI thrashing when agents update independently.
 *
 * Uses microtask debouncing: updates within the same event-loop tick
 * are coalesced into one flush. No artificial interval — updates hit the
 * screen as soon as the current tick yields, but never duplicatively.
 */
export class WidgetBatcher {
	/** Pending widget updates keyed by widget key. */
	private pending: Map<string, string[]> = new Map();

	/** Widget keys scheduled for removal. */
	private pendingRemovals: Set<string> = new Set();

	/** Whether a microtask flush is already queued. */
	private scheduled = false;

	/** Whether a flush is currently executing (prevents re-entry). */
	private flushing = false;

	constructor(private ctx: ExtensionContext) {}

	/**
	 * Schedule a widget update. Flushed asynchronously at end of the
	 * current event-loop tick; multiple calls in the same tick coalesce.
	 */
	schedule(key: string, lines: string[]): void {
		this.pending.set(key, lines);
		this.scheduleFlush();
	}

	/**
	 * Remove a widget (e.g., when a task completes).
	 * Flushed asynchronously at end of the current tick.
	 */
	scheduleRemove(key: string): void {
		this.pending.delete(key);
		this.pendingRemovals.add(key);
		this.scheduleFlush();
	}

	/** Synchronously flush all pending updates. */
	flush(): void {
		this.doFlush();
	}

	/** Flush remaining updates then stop scheduling. */
	stop(): void {
		this.doFlush();
	}

	// ── Internal ────────────────────────────────────────────────────────

	private scheduleFlush(): void {
		if (this.scheduled) return;
		this.scheduled = true;
		queueMicrotask(() => {
			this.scheduled = false;
			this.doFlush();
		});
	}

	private doFlush(): void {
		if (this.flushing) return;
		this.flushing = true;

		// Atomically swap — new schedule()/scheduleRemove() calls land on fresh
		// collections, so the batch we iterate stays immutable and nothing is lost.
		const toRender = this.pending;
		const toRemove = this.pendingRemovals;
		this.pending = new Map();
		this.pendingRemovals = new Set();

		// Apply removals first
		for (const key of toRemove) {
			this.ctx.ui.setWidget(key, undefined);
		}

		// Sort by key for deterministic, stable ordering across every flush.
		// Task IDs are zero-padded ("008", "012", "013") so alpha sort = numeric order.
		const sortedKeys = Array.from(toRender.keys()).sort();
		for (const key of sortedKeys) {
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			this.ctx.ui.setWidget(key, toRender.get(key)!);
		}

		this.flushing = false;
	}
}
