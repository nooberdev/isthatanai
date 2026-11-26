<script lang="ts">
	// Auto-test de la demo: ejecuta los perfiles deterministas y compara la
	// banda medida con la esperada. NO hay agentes de navegador reales aquí.

	import { onMount } from "svelte";
	import { AI_MIN, HUMAN_MAX } from "is-that-an-ai";
	import { PROFILES, measure, type Band, type SimulationResult } from "#lib/lab/simulation";
	import { tr, type DemoTranslationKey } from "#lib/i18n";

	const BAND_KEY: Record<Band, DemoTranslationKey> = {
		humano: "band.human",
		"zona media": "band.middle",
		agente: "band.agent",
		"sin evidencia": "band.noEvidence"
	};

	interface Check extends SimulationResult {
		expected: Band;
		passed: boolean;
	}

	let checks = $state<Check[]>([]);

	function runAll(): void {
		checks = PROFILES.map((profile) => {
			const result = measure(profile.id, profile.generate());
			return { ...result, expected: profile.expected, passed: result.band === profile.expected };
		});
	}

	const passedCount = $derived(checks.filter((check) => check.passed).length);

	function profileName(id: string): string {
		const key = PROFILES.find((p) => p.id === id)?.nameKey;
		return key === undefined ? id : tr(key);
	}

	onMount(runAll);
</script>

<section class="at-section" aria-labelledby="at-title">
	<div class="at-content">
		<h2 id="at-title" class="section-title">{tr("autotest.title")}</h2>
		<p class="section-body">
			{tr("autotest.body1", { humanMax: HUMAN_MAX, aiMin: AI_MIN })}<br />
			{tr("autotest.body2a")}<strong>{tr("simulated")}</strong>{tr("autotest.body2b")}
		</p>

		<div class="at-card">
			<div class="at-card-head">
				<h3 class="at-card-title">{tr("autotest.cardTitle")} <span class="at-tag">{tr("simulated")}</span></h3>
				<p class="at-meta" aria-live="polite">
					{checks.length === 0
						? tr("autotest.preparing")
						: tr("autotest.progress", { passed: passedCount, total: checks.length })}
				</p>
			</div>
			<div class="at-actions">
				<button type="button" class="at-button" onclick={runAll}>{tr("autotest.button.run")}</button>
			</div>
			<div class="at-scroll">
				<table>
					<caption class="at-sr-only">{tr("autotest.caption")}</caption>
					<thead>
						<tr>
							<th scope="col">{tr("table.th.profile")}</th>
							<th scope="col">{tr("table.th.expected")}</th>
							<th scope="col">{tr("table.th.observed")}</th>
							<th scope="col">{tr("table.th.score")}</th>
							<th scope="col">{tr("table.th.result")}</th>
						</tr>
					</thead>
					<tbody>
						{#each checks as check (check.id)}
							<tr>
								<th scope="row">
									<span class="at-row-name">{profileName(check.id)}</span>
									<span class="at-row-meta">{tr("simulated")} · {tr("autotest.row.meta")}</span>
								</th>
								<td>{tr(BAND_KEY[check.expected])}</td>
								<td>{tr(BAND_KEY[check.band])}</td>
								<td class="at-score">{check.score === null ? "—" : check.score.toFixed(2)}</td>
								<td class="at-result" class:at-result--fail={!check.passed}>
									{check.passed ? tr("autotest.pass") : tr("autotest.fail")}
								</td>
							</tr>
						{/each}
						{#if checks.length === 0}
							<tr>
								<td colspan="5" class="at-note">{tr("autotest.note")}</td>
							</tr>
						{/if}
					</tbody>
				</table>
			</div>
		</div>

		<p class="at-footnote">
			{tr("autotest.footnote1")}<strong>{tr("autotest.footnoteStrong")}</strong>{tr("autotest.footnote2")}
		</p>
	</div>
</section>

<style>
	.at-section { gap: 1rem; }
	.at-content {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.9rem;
		width: min(60rem, 100%);
	}
	.at-card {
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
	.at-card-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.4rem 0.75rem;
	}
	.at-card-title { margin: 0; font-size: 0.8125rem; font-weight: 600; }
	.at-meta, .at-footnote, .at-note { margin: 0; font-size: 0.6875rem; color: var(--muted-foreground); }
	.at-meta, .at-footnote { line-height: 1.5; }
	.at-tag {
		display: inline-block;
		margin-left: 0.3rem;
		border: 1px solid color-mix(in srgb, var(--foreground) 30%, transparent);
		border-radius: var(--radius-sm);
		padding: 0.05rem 0.3rem;
		font-size: 0.5625rem;
		font-weight: 600;
		letter-spacing: 0.08em;
		vertical-align: 0.05rem;
	}
	.at-button {
		align-self: flex-start;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--card);
		color: var(--foreground);
		padding: 0.25rem 0.55rem;
		font: inherit;
		font-size: 0.6875rem;
		cursor: pointer;
		transition: background-color var(--dur-180);
	}
	.at-button:hover { background: var(--accent); }
	.at-scroll { width: 100%; overflow-x: auto; }
	table { width: 100%; min-width: 40rem; border-collapse: collapse; font-size: 0.75rem; }
	caption { text-align: left; }
	th, td { padding: 0.45rem 0.55rem; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
	thead th { font-size: 0.625rem; font-weight: 600; text-transform: uppercase; color: var(--muted-foreground); }
	tbody th { font-weight: 400; }
	tbody tr:last-child th, tbody tr:last-child td { border-bottom: 0; }
	.at-row-name, .at-score { display: block; font-variant-numeric: tabular-nums; }
	.at-row-name { font-weight: 600; }
	.at-row-meta { display: block; margin-top: 0.1rem; font-size: 0.625rem; color: var(--muted-foreground); }
	.at-score { font-size: 0.875rem; font-weight: 600; }
	.at-result { white-space: nowrap; color: color-mix(in srgb, var(--color-verdict-humano) 72%, var(--foreground)); }
	.at-result--fail { color: color-mix(in srgb, var(--color-verdict-ia) 72%, var(--foreground)); }
	.at-sr-only {
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
	@media (prefers-reduced-motion: reduce) { .at-button { transition: none; } }
</style>
