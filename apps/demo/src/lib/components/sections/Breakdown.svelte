<script lang="ts">
	// Panel de puntaje en vivo: lee la instancia única del detector, sin
	// simulaciones. Las señales sin evidencia suficiente se muestran como «—».

	import type { SignalScores } from "is-that-an-ai";
	import { live } from "#lib/detector/live.svelte";
	import { tr, type DemoTranslationKey } from "#lib/i18n";

	const SIGNALS: Array<{ id: keyof SignalScores; nameKey: DemoTranslationKey; detailKey: DemoTranslationKey }> = [
		{ id: "mouse", nameKey: "signal.mouse.name", detailKey: "signal.mouse.detail" },
		{ id: "click", nameKey: "signal.click.name", detailKey: "signal.click.detail" },
		{ id: "scroll", nameKey: "signal.scroll.name", detailKey: "signal.scroll.detail" },
		{ id: "keyboard", nameKey: "signal.keyboard.name", detailKey: "signal.keyboard.detail" }
	];

	// Datos del sondeo compartido: el store solo publica cuando cambian.
	let scores = $derived(live.scores);
	let verdict = $derived(live.verdict);
	let stats = $derived(live.stats);

	const verdictLabel = $derived(
		verdict.state === "ai"
			? tr("label.ai")
			: verdict.state === "human"
				? tr("label.human")
				: tr("label.measuring")
	);
	const scoreText = $derived(verdict.score === null ? "—" : verdict.score.toFixed(2));

	// Etapa 10: solo observabilidad; nunca fija ni fuerza el veredicto.
	let liveness = $derived(live.liveness);
	let integrity = $derived(live.integrity);
	let replay = $derived(live.replay);
	let surprise = $derived(live.surprise);

	// Etapa 12: lecturas opcionales del mismo sondeo, sin ningún intervalo nuevo.
	let privacyMode = $derived(live.privacyMode);
	let touchCount = $derived(live.touchCount);
	let attentionCount = $derived(live.attentionCount);
	let calibration = $derived(live.calibration);

	const livenessLabel = $derived(
		liveness.status === "live"
			? tr("breakdown.status.live")
			: liveness.status === "stale"
				? tr("breakdown.status.stale")
				: liveness.status === "idle"
					? tr("breakdown.status.idle")
					: "—"
	);
	const integrityLabel = $derived(
		integrity.ok === null
			? "—"
			: integrity.ok
				? tr("breakdown.status.ok")
				: tr("breakdown.status.fail")
	);
	const integrityReason = $derived(
		integrity.ok === false
			? integrity.checks.filter((check) => !check.ok).map((check) => check.name).join(" · ")
			: ""
	);

	const replayParts = $derived(
		[
			replay.repeatedPath > 0
				? `${tr("breakdown.status.replay.path")} ${replay.repeatedPath}`
				: "",
			replay.repeatedTiming > 0
				? `${tr("breakdown.status.replay.timing")} ${replay.repeatedTiming}`
				: "",
			replay.identicalSequence > 0
				? `${tr("breakdown.status.replay.sequence")} ${replay.identicalSequence}`
				: ""
		].filter((part) => part !== "")
	);
	const replayWarning = $derived(
		replayParts.length > 0
			? tr("breakdown.status.replay", { detail: replayParts.join(", ") })
			: ""
	);
	const surpriseWarning = $derived(
		surprise.passed === false
			? tr("breakdown.status.surprise", {
					reason: surprise.reason.trim() === "" ? "—" : surprise.reason
				})
			: ""
	);

	const privacyLabel = $derived(
		privacyMode === "full"
			? tr("breakdown.privacy.full")
			: privacyMode === "aggregates"
				? tr("breakdown.privacy.aggregates")
				: "—"
	);
	const extraCounts = $derived(
		touchCount !== null && attentionCount !== null && (touchCount > 0 || attentionCount > 0)
			? tr("breakdown.measures.counts", { touch: touchCount, attention: attentionCount })
			: ""
	);
	const calibrationLabel = $derived(
		calibration === null
			? ""
			: calibration.applied
				? tr("breakdown.calibration.on", { samples: calibration.samples })
				: tr("breakdown.calibration.off")
	);
</script>

<section class="section bd-section" aria-labelledby="bd-title">
	<div class="bd-content">
		<h2 id="bd-title" class="section-title">{tr("breakdown.title")}</h2>
		<p class="section-body">
			{tr("breakdown.body1")}<br />
			{tr("breakdown.body2")}
		</p>

		<div class="bd-grid">
			<div class="bd-card bd-card--summary">
				<h3 class="bd-card-title">{tr("breakdown.verdict")}</h3>
				<p class="bd-score" class:bd-score--agent={verdict.state === "ai"}>{scoreText}</p>
				<p class="bd-state">{verdictLabel}</p>
				<dl class="bd-facts">
					<div><dt>{tr("breakdown.confidence")}</dt><dd>{(verdict.confidence * 100).toFixed(0)} %</dd></div>
					<div><dt>{tr("breakdown.doubt")}</dt><dd>{(verdict.doubt * 100).toFixed(0)} %</dd></div>
				</dl>
				<p class="bd-meta">
					{tr("breakdown.meta", {
						samples: stats.sampleCount,
						clicks: stats.clickCount,
						scrolls: stats.scrollCount,
						keys: stats.keyCount,
						inputs: stats.inputCount
					})}
				</p>

				<div class="bd-status">
					<p class="bd-status-title">{tr("breakdown.status.title")}</p>
					<div class="bd-status-grid">
						<div class="bd-status-cell">
							<span class="bd-status-key">
								<span
									class="bd-dot"
									class:bd-dot--live={liveness.status === "live"}
									class:bd-dot--stale={liveness.status === "stale"}
									class:bd-dot--idle={liveness.status === "idle"}
									aria-hidden="true"
								></span>
								{tr("breakdown.status.liveness")}
							</span>
							<span class="bd-status-value">{livenessLabel}</span>
						</div>
						<div class="bd-status-cell">
							<span class="bd-status-key">{tr("breakdown.status.integrity")}</span>
							<span class="bd-status-value" class:bd-status-value--fail={integrity.ok === false}>{integrityLabel}</span>
							{#if integrityReason}
								<span class="bd-status-reason">{integrityReason}</span>
							{/if}
						</div>
						<div class="bd-status-cell">
							<span class="bd-status-key">{tr("breakdown.privacy")}</span>
							<span class="bd-status-value">{privacyLabel}</span>
						</div>
						{#if extraCounts}
							<div class="bd-status-cell">
								<span class="bd-status-key">{tr("breakdown.measures")}</span>
								<span class="bd-status-value">{extraCounts}</span>
							</div>
						{/if}
						{#if calibrationLabel}
							<div class="bd-status-cell">
								<span class="bd-status-key">{tr("breakdown.calibration")}</span>
								<span class="bd-status-value">{calibrationLabel}</span>
							</div>
						{/if}
					</div>
					{#if replayWarning}
						<p class="bd-status-warning">{replayWarning}</p>
					{/if}
					{#if surpriseWarning}
						<p class="bd-status-warning">{surpriseWarning}</p>
					{/if}
					<p class="bd-status-note">{tr("breakdown.status.note")}</p>
				</div>
			</div>

			<div class="bd-card">
				<div class="bd-card-head">
					<h3 class="bd-card-title">{tr("breakdown.signals")}</h3>
					<p class="bd-meta">{tr("breakdown.scale")}</p>
				</div>
				<table>
					<caption class="bd-sr-only">{tr("breakdown.caption")}</caption>
					<thead>
						<tr>
							<th scope="col">{tr("breakdown.th.signal")}</th>
							<th scope="col">{tr("breakdown.th.score")}</th>
						</tr>
					</thead>
					<tbody>
						{#each SIGNALS as signal (signal.id)}
							{@const value = scores[signal.id]}
							<tr>
								<th scope="row">
									<span class="bd-row-name">{tr(signal.nameKey)}</span>
									<span class="bd-row-meta">{tr(signal.detailKey)}</span>
								</th>
								<td>
									<span class="bd-value">{value === null ? "—" : value.toFixed(2)}</span>
									<span class="bd-bar" aria-hidden="true">
										<span class="bd-bar-fill" style="width: {value === null ? 0 : value * 100}%"></span>
									</span>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>

		<div class="bd-card bd-card--reasons">
			<h3 class="bd-card-title">{tr("breakdown.reasons")}</h3>
			{#if verdict.reasons.length > 0}
				<ul>
					{#each verdict.reasons.slice(0, 3) as reason}
						<li>{reason}</li>
					{/each}
				</ul>
			{:else}
				<p class="bd-meta">{tr("breakdown.reasons.empty")}</p>
			{/if}
		</div>
	</div>
</section>

<style>
	.bd-section { gap: 1rem; }
	.bd-content {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.9rem;
		width: min(60rem, 100%);
	}
	.bd-grid {
		display: grid;
		grid-template-columns: minmax(14rem, 0.6fr) minmax(0, 1.4fr);
		gap: 0.75rem;
		width: 100%;
	}
	.bd-card {
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		min-width: 0;
		padding: 0.85rem 0.95rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--card) 94%, var(--muted));
	}
	.bd-card-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.4rem 0.75rem;
	}
	.bd-card-title { margin: 0; font-size: 0.8125rem; font-weight: 600; }
	.bd-score {
		margin: 0;
		font-size: clamp(2rem, 5vw, 3rem);
		font-weight: 600;
		letter-spacing: -0.04em;
		line-height: 1;
		font-variant-numeric: tabular-nums;
		color: var(--color-verdict-humano);
	}
	.bd-score--agent { color: var(--color-verdict-ia); }
	.bd-state { margin: 0; font-size: 0.75rem; font-weight: 600; text-transform: capitalize; }
	.bd-facts { display: flex; gap: 1rem; margin: 0; }
	.bd-facts div { display: flex; flex-direction: column; }
	.bd-facts dt { font-size: 0.625rem; color: var(--muted-foreground); }
	.bd-facts dd { margin: 0; font-size: 0.8125rem; font-variant-numeric: tabular-nums; }
	.bd-meta { margin: 0; font-size: 0.6875rem; color: var(--muted-foreground); line-height: 1.5; }
	.bd-status {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		margin-top: 0.1rem;
		padding-top: 0.55rem;
		border-top: 1px solid var(--border);
	}
	.bd-status-title {
		margin: 0;
		font-size: 0.625rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--muted-foreground);
	}
	.bd-status-grid { display: flex; flex-wrap: wrap; gap: 0.3rem 1rem; }
	.bd-status-cell { display: flex; flex-wrap: wrap; align-items: center; gap: 0.3rem; font-size: 0.6875rem; }
	.bd-status-key {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		color: var(--muted-foreground);
	}
	.bd-status-value { font-weight: 600; font-variant-numeric: tabular-nums; }
	.bd-status-value--fail { color: var(--color-verdict-ia); }
	.bd-status-reason {
		flex-basis: 100%;
		font-size: 0.625rem;
		color: var(--muted-foreground);
		overflow-wrap: anywhere;
	}
	.bd-dot {
		width: 6px;
		height: 6px;
		flex: none;
		border-radius: 50%;
		background: var(--color-verdict-midiendo);
	}
	.bd-dot--live { background: var(--color-verdict-humano); }
	.bd-dot--stale { background: var(--color-verdict-humano-doubt); }
	.bd-dot--idle { background: var(--color-verdict-midiendo); }
	.bd-status-warning {
		display: flex;
		align-items: baseline;
		gap: 0.35rem;
		margin: 0;
		font-size: 0.625rem;
		line-height: 1.5;
		color: var(--muted-foreground);
	}
	.bd-status-warning::before {
		content: "";
		width: 5px;
		height: 5px;
		flex: none;
		border-radius: 50%;
		background: var(--color-verdict-humano-doubt);
	}
	.bd-status-note { margin: 0; font-size: 0.625rem; line-height: 1.5; color: var(--muted-foreground); }
	table { width: 100%; border-collapse: collapse; font-size: 0.75rem; }
	caption { text-align: left; }
	th, td { padding: 0.35rem 0.45rem; border-bottom: 1px solid var(--border); text-align: left; }
	thead th { font-size: 0.625rem; font-weight: 600; text-transform: uppercase; color: var(--muted-foreground); }
	tbody th { font-weight: 400; }
	tbody tr:last-child th, tbody tr:last-child td { border-bottom: 0; }
	.bd-row-name, .bd-value { display: block; font-variant-numeric: tabular-nums; }
	.bd-row-name { font-weight: 600; }
	.bd-row-meta { display: block; font-size: 0.625rem; color: var(--muted-foreground); }
	.bd-bar {
		display: block;
		height: 3px;
		margin-top: 0.25rem;
		border-radius: 9999px;
		background: color-mix(in srgb, var(--muted) 80%, var(--border));
	}
	.bd-bar-fill {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: color-mix(in srgb, var(--color-verdict-ia) 70%, var(--foreground));
		transition: width var(--dur-180);
	}
	.bd-card--reasons ul { margin: 0; padding-left: 1.1rem; font-size: 0.75rem; line-height: 1.6; }
	.bd-sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
		border: 0;
	}
	@media (max-width: 900px) { .bd-grid { grid-template-columns: minmax(0, 1fr); } }
	@media (prefers-reduced-motion: reduce) { .bd-bar-fill { transition: none; } }
</style>
