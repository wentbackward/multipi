/**
 * Live registry of children dispatched from THIS orchestrator session.
 *
 * The dispatch children run in-process (spawnPi), so this module sees their live progress
 * — turns, tokens, cost, current activity — that the on-disk state file only records at
 * the end. The TUI widget bar and the /devloop-agents panel read from here.
 *
 * Pure node: no pi imports. tools.ts feeds it; index.ts renders from it.
 */

export interface ChildEvent {
	/** epoch ms */
	at: number;
	kind: "start" | "tool" | "turn" | "end";
	text: string;
}

export interface ChildUsage {
	input: number;
	output: number;
	cost: number;
	totalTokens: number;
}

export interface LiveChild {
	key: string;
	role: string;
	ticket?: number;
	branch?: string;
	worktree: string;
	startedAt: number;
	status: "running" | "done" | "crashed" | "interrupted" | "blocked";
	endedAt?: number;
	turns: number;
	usage: ChildUsage;
	activity: string;
	/** Most recent events, oldest first, capped. */
	events: ChildEvent[];
}

/** Events kept per child (ring buffer). */
const EVENT_CAP = 40;
/** Terminated children kept for the panel (running ones always kept). */
const FINISHED_CAP = 8;

const children = new Map<string, LiveChild>();
let listeners: (() => void)[] = [];

export function addChild(c: LiveChild): void {
	children.set(c.key, { ...c, events: [...c.events] });
	enforceFinishedCap();
	notify();
}

export function updateChild(key: string, patch: Partial<Omit<LiveChild, "key" | "events">>, event?: ChildEvent): void {
	const cur = children.get(key);
	if (!cur) return;
	Object.assign(cur, patch);
	if (event) {
		cur.events.push(event);
		while (cur.events.length > EVENT_CAP) cur.events.shift();
	}
	enforceFinishedCap();
	notify();
}

export function runningChildren(): LiveChild[] {
	return [...children.values()].filter((c) => c.status === "running");
}

/** Running first, then the most recently finished — for the panel. */
export function liveChildren(): LiveChild[] {
	const all = [...children.values()];
	const running = all.filter((c) => c.status === "running");
	const finished = all
		.filter((c) => c.status !== "running")
		.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
	return [...running, ...finished];
}

function enforceFinishedCap(): void {
	const finished = [...children.values()]
		.filter((c) => c.status !== "running")
		.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
	for (const c of finished.slice(FINISHED_CAP)) children.delete(c.key);
}

/** Subscribe to any registry change. Returns an unsubscribe function. */
export function onChange(fn: () => void): () => void {
	listeners.push(fn);
	return () => {
		listeners = listeners.filter((l) => l !== fn);
	};
}

function notify(): void {
	for (const l of [...listeners]) {
		try {
			l();
		} catch {
			/* a broken listener must not break dispatch */
		}
	}
}

/** Test seam / session teardown. */
export function resetChildren(): void {
	children.clear();
	listeners = [];
}

// ---- rendering (pure, width-aware) ----------------------------------------

export function formatElapsed(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	const mmss = `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
	return h > 0 ? `${h}:${mmss}` : mmss;
}

export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
	if (n >= 1_000) return `${Math.round(n / 100) / 10}k`;
	return String(n);
}

function truncate(s: string, width: number): string {
	// Visible-width approximation: the bar text is ASCII by construction (role, path, command).
	if (s.length <= width) return s;
	return `${s.slice(0, Math.max(0, width - 1))}…`;
}

/**
 * One line per RUNNING child for the widget bar:
 *   ● implementer #2 · 12:03 · tok 132k · $1.44 · bash: npm run test:unit
 * Returns [] when nothing is running (the caller hides the widget).
 */
export function renderChildBar(list: Pick<LiveChild, "key" | "role" | "ticket" | "status" | "startedAt" | "endedAt" | "usage" | "activity">[], now: number, width = 1000): string[] {
	const lines: string[] = [];
	for (const c of list.filter((c) => c.status === "running")) {
		const who = c.ticket !== undefined ? `${c.role} #${c.ticket}` : c.role;
		const el = formatElapsed(now - c.startedAt);
		const tok = formatTokens(c.usage.totalTokens);
		const cost = `$${c.usage.cost.toFixed(2)}`;
		const act = c.activity || "starting";
		const line = `● ${who} · ${el} · tok ${tok} · ${cost} · ${act}`;
		lines.push(truncate(line, width));
	}
	return lines;
}

// ---- /devloop-agents panel (pure renderer) --------------------------------

const KIND_TAG: Record<ChildEvent["kind"], string> = { start: "[start]", tool: "[tool] ", turn: "[turn] ", end: "[end]  " };

/**
 * Render the browse panel: selectable child list + the selected child's event tail.
 * Pure: (children, selection, scroll, width) -> lines.
 */
export function renderAgentsPanel(
	kids: Pick<LiveChild, "key" | "role" | "ticket" | "branch" | "worktree" | "status" | "startedAt" | "endedAt" | "usage" | "events">[],
	sel: number,
	scroll: number,
	width: number,
	now: number,
): string[] {
	const lines: string[] = [];
	const usable = Math.max(20, width);
	const clip = (s: string) => (s.length > usable ? `${s.slice(0, usable - 1)}…` : s);

	lines.push(clip(` Devloop agents — ${kids.filter((k) => k.status === "running").length} running, ${kids.filter((k) => k.status !== "running").length} recent`));
	if (kids.length === 0) {
		lines.push(clip("  No children dispatched yet this session."));
		lines.push(clip("  q: close"));
		return lines;
	}
	kids.forEach((k, i) => {
		const who = k.ticket !== undefined ? `${k.role} #${k.ticket}` : k.role;
		const el = formatElapsed((k.endedAt ?? now) - k.startedAt);
		const tok = formatTokens(k.usage.totalTokens);
		const cost = `$${k.usage.cost.toFixed(2)}`;
		const mark = i === sel ? "▶" : " ";
		const dot = k.status === "running" ? "●" : "○";
		lines.push(clip(`${mark} ${dot} ${who}  ${k.status.toUpperCase().padEnd(11)} ${el}  tok ${tok}  ${cost}`));
	});
	const k = kids[Math.min(sel, kids.length - 1)];
	lines.push("─".repeat(Math.min(usable, 72)));
	lines.push(clip(` ${k.ticket !== undefined ? `${k.role} #${k.ticket}` : k.role} · ${k.branch ?? "(no branch)"} · ${k.worktree}`));
	const events = k.events;
	if (events.length === 0) {
		lines.push(clip("  (no events recorded)"));
	} else {
		// scroll = events hidden below the window (0 = latest); window shows up to WIN lines.
		const win = 10;
		const hi = Math.max(0, events.length - 1 - scroll);
		const lo = Math.max(0, hi - win + 1);
		for (let i = lo; i <= hi; i++) {
			const e = events[i]!;
			const rel = formatElapsed(e.at - k.startedAt);
			lines.push(clip(` ${rel.padStart(7)} ${KIND_TAG[e.kind]} ${e.text.replace(/\s+/g, " ").slice(0, usable - 16)}`));
		}
	}
	lines.push(clip(" ↑/↓ select · PgUp/PgDn scroll · q close"));
	return lines;
}
