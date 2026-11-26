<script lang="ts">
	// Visualizador mínimo del camino del puntero: trazo en vivo o camino de la
	// sesión grabada/importada. Mismo escalado para X e Y, sin animaciones.

	import { frameOf, spanLabel, VIEW_H, VIEW_W } from "#lib/lab/path";
	import type { SessionRecord } from "#lib/lab/session";
	import { live } from "#lib/detector/live.svelte";
	import { tr } from "#lib/i18n";

	let { session }: { session: SessionRecord | null } = $props();

	let mode = $state<"live" | "session">("live");

	$effect(() => {
		if (mode === "session" && !session) mode = "live";
	});

	let points = $derived(live.points);

	const shown = $derived(mode === "session" && session ? session.samples.points : points);
	const moving = $derived(shown.filter((p) => p.kind === 0));
	const frame = $derived(frameOf(moving));
	const span = $derived(spanLabel(moving));
	const sourceLabel = $derived(
		mode === "session" ? tr("pathview.source.session") : tr("pathview.source.live")
	);
</script>

<section class="pv-section" aria-labelledby="pv-title">
	<div class="pv-content">
		<h2 id="pv-title" class="section-title">{tr("pathview.title")}</h2>
		<p class="section-body">
			{tr("pathview.body1")}<br />
			{tr("pathview.body2")}
		</p>

		<div class="pv-card">
			<div class="pv-card-head">
				<h3 class="pv-card-title">{sourceLabel}</h3>
				<p class="pv-meta">{tr("pathview.meta", { count: moving.length, span })}</p>
			</div>
			<div class="pv-toggle" role="group" aria-label={tr("pathview.group.aria")}>
				<button
					type="button"
					class="pv-chip"
					class:is-active={mode === "live"}
					aria-pressed={mode === "live"}
					onclick={() => (mode = "live")}>{tr("pathview.button.live")}</button
				>
				<button
					type="button"
					class="pv-chip"
					class:is-active={mode === "session"}
					aria-pressed={mode === "session"}
					disabled={!session}
					onclick={() => (mode = "session")}>{tr("pathview.button.session")}</button
				>
			</div>
			<div class="pv-canvas">
				<svg
					viewBox="0 0 {VIEW_W} {VIEW_H}"
					role="img"
					aria-label={tr("pathview.svg.aria", { source: sourceLabel, count: moving.length, span })}
					preserveAspectRatio="xMidYMid meet"
				>
					<defs>
						<pattern
							id="pv-grid-pattern"
							class="pv-grid-pattern"
							width="10"
							height="10"
							patternUnits="userSpaceOnUse"
						>
							<path d="M 10 0 L 0 0 0 10" fill="none" stroke="currentColor" stroke-width="0.2" />
						</pattern>
					</defs>
					<rect
						x="0"
						y="0"
						width={VIEW_W}
						height={VIEW_H}
						fill="url(#pv-grid-pattern)"
						aria-hidden="true"
					/>
					{#if frame}
						<polyline
							points={frame.path.join(" ")}
							fill="none"
							stroke="currentColor"
							stroke-width="1.5"
							stroke-linecap="round"
							stroke-linejoin="round"
							vector-effect="non-scaling-stroke"
							class="pv-path"
							aria-hidden="true"
						/>
						<circle cx={frame.start.x} cy={frame.start.y} r="1.5" class="pv-start" aria-hidden="true" />
						<circle cx={frame.end.x} cy={frame.end.y} r="1.5" class="pv-end" aria-hidden="true" />
					{/if}
				</svg>
				{#if !frame}
					<p class="pv-empty">
						{mode === "session" ? tr("pathview.empty.session") : tr("pathview.empty.live")}
					</p>
				{/if}
			</div>
			<div class="pv-legend">
				<span><i class="pv-key pv-key--start" aria-hidden="true"></i>{tr("legend.start")}</span>
				<span><i class="pv-key pv-key--end" aria-hidden="true"></i>{tr("legend.end")}</span>
				<span class="pv-legend-note">{tr("legend.scale")}</span>
			</div>
		</div>
		<p class="pv-footnote">{tr("pathview.footnote")}</p>
	</div>
</section>

<style>
	.pv-section { gap: 1rem; }
	.pv-content {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.9rem;
		width: min(60rem, 100%);
	}
	.pv-card {
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		width: 100%;
		padding: 0.85rem 0.95rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--card) 94%, var(--muted));
	}
	.pv-card-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.4rem 0.75rem;
	}
	.pv-card-title { margin: 0; font-size: 0.8125rem; font-weight: 600; }
	.pv-meta, .pv-legend, .pv-footnote {
		margin: 0;
		font-size: 0.6875rem;
		color: var(--muted-foreground);
	}
	.pv-toggle { display: inline-flex; gap: 0.25rem; }
	.pv-chip {
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--card);
		color: var(--foreground);
		padding: 0.25rem 0.55rem;
		font: inherit;
		font-size: 0.6875rem;
		cursor: pointer;
		transition: background-color var(--dur-180), color var(--dur-180);
	}
	.pv-chip:hover:not(:disabled) { background: var(--accent); }
	.pv-chip.is-active { background: var(--foreground); color: var(--background); }
	.pv-chip:disabled { opacity: 0.5; cursor: not-allowed; }
	.pv-canvas { position: relative; width: 100%; }
	.pv-canvas svg {
		display: block;
		width: 100%;
		height: auto;
		aspect-ratio: 100 / 62;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--muted) 40%, var(--card));
	}
	.pv-grid-pattern { color: var(--border); }
	.pv-path { color: color-mix(in srgb, var(--foreground) 80%, transparent); }
	.pv-start { fill: var(--color-verdict-humano); }
	.pv-end { fill: var(--color-verdict-ia); }
	.pv-empty {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		margin: 0;
		font-size: 0.75rem;
		color: var(--muted-foreground);
		pointer-events: none;
	}
	.pv-legend { display: flex; flex-wrap: wrap; align-items: center; gap: 0.9rem; }
	.pv-legend span { display: inline-flex; align-items: center; gap: 0.3rem; }
	.pv-key { width: 0.5rem; height: 0.5rem; border-radius: 9999px; }
	.pv-key--start { background: var(--color-verdict-humano); }
	.pv-key--end { background: var(--color-verdict-ia); }
	.pv-legend-note { margin-left: auto; opacity: 0.8; }
	.pv-footnote { width: 100%; line-height: 1.5; }
	@media (prefers-reduced-motion: reduce) { .pv-chip { transition: none; } }
</style>
