<script lang="ts">
	// Simulador: dos trazos deterministas pasan por el colector público y por
	// ScoreComputer. Puntajes medidos, no estimados. Etiqueta SIMULADO.

	import { PROFILES, measure, type Band, type SimulationResult } from "#lib/lab/simulation";
	import { i18n, tr, type DemoTranslationKey } from "#lib/i18n";

	const BAND_KEY: Record<Band, DemoTranslationKey> = {
		humano: "band.human",
		"zona media": "band.middle",
		agente: "band.agent",
		"sin evidencia": "band.noEvidence"
	};

	let results = $state<SimulationResult[]>([]);

	function runAll(): void {
		results = PROFILES.map((profile) => measure(profile.id, profile.generate()));
	}

	// Las razones llegan localizadas de la librería: al cambiar de idioma se
	// repite la misma medición determinista para que la tabla no quede vieja.
	$effect(() => {
		void i18n.locale;
		runAll();
	});
</script>

<section class="section bs-section" aria-labelledby="bs-title">
	<div class="bs-content">
		<h2 id="bs-title" class="section-title">{tr("botsim.title")}</h2>
		<p class="section-body">
			{tr("botsim.body1")}<br />
			{tr("botsim.body2a")}<strong>{tr("simulated")}</strong>{tr("botsim.body2b")}
		</p>

		<div class="bs-card">
			<div class="bs-card-head">
				<h3 class="bs-card-title">{tr("botsim.cardTitle")} <span class="bs-tag">{tr("simulated")}</span></h3>
				<p class="bs-meta">{tr("breakdown.scale")}</p>
			</div>
			<div class="bs-actions">
				<button type="button" class="bs-button" onclick={runAll}>{tr("botsim.button.repeat")}</button>
			</div>
			<div class="bs-scroll">
				<table>
					<caption class="bs-sr-only">{tr("botsim.caption")}</caption>
					<thead>
						<tr>
							<th scope="col">{tr("table.th.profile")}</th>
							<th scope="col">{tr("table.th.score")}</th>
							<th scope="col">{tr("table.th.verdict")}</th>
							<th scope="col">{tr("table.th.detected")}</th>
							<th scope="col">{tr("table.th.limitation")}</th>
						</tr>
					</thead>
					<tbody>
						{#each results as result (result.id)}
							{@const profile = PROFILES.find((p) => p.id === result.id)}
							<tr>
								<th scope="row">
									<span class="bs-row-name">{profile ? tr(profile.nameKey) : result.id}</span>
									<span class="bs-row-meta">{tr("simulated")} · {profile ? tr(profile.detailKey) : ""}</span>
								</th>
								<td>
									<span class="bs-score">{result.score === null ? "—" : result.score.toFixed(2)}</span>
									<span class="bs-row-meta">{result.reason}</span>
								</td>
								<td class="bs-band" class:bs-band--agent={result.band === "agente"}>
									{tr(BAND_KEY[result.band])}
								</td>
								<td>{result.detected ? tr("yes") : tr("no")}</td>
								<td class="bs-limitation">{profile ? tr(profile.limitationKey) : ""}</td>
							</tr>
						{/each}
						{#if results.length === 0}
							<tr>
								<td colspan="5" class="bs-limitation">{tr("preparing")}</td>
							</tr>
						{/if}
					</tbody>
				</table>
			</div>
		</div>

		<p class="bs-footnote">{tr("botsim.footnote")}</p>
	</div>
</section>

<style>
	.bs-section { gap: 1rem; }
	.bs-content {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.9rem;
		width: min(60rem, 100%);
	}
	.bs-card {
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
	.bs-card-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.4rem 0.75rem;
	}
	.bs-card-title { margin: 0; font-size: 0.8125rem; font-weight: 600; }
	.bs-meta, .bs-footnote, .bs-limitation { font-size: 0.6875rem; color: var(--muted-foreground); }
	.bs-meta, .bs-footnote { margin: 0; line-height: 1.5; }
	.bs-tag {
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
	.bs-button {
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
	.bs-button:hover { background: var(--accent); }
	.bs-scroll { width: 100%; overflow-x: auto; }
	table { width: 100%; min-width: 44rem; border-collapse: collapse; font-size: 0.75rem; }
	caption { text-align: left; }
	th, td { padding: 0.45rem 0.55rem; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
	thead th { font-size: 0.625rem; font-weight: 600; text-transform: uppercase; color: var(--muted-foreground); }
	tbody th { font-weight: 400; }
	tbody tr:last-child th, tbody tr:last-child td { border-bottom: 0; }
	.bs-row-name, .bs-score { display: block; font-variant-numeric: tabular-nums; }
	.bs-row-name { font-weight: 600; }
	.bs-score { font-size: 0.875rem; font-weight: 600; }
	.bs-row-meta { display: block; margin-top: 0.1rem; font-size: 0.625rem; color: var(--muted-foreground); }
	.bs-band { white-space: nowrap; color: color-mix(in srgb, var(--color-verdict-humano) 72%, var(--foreground)); }
	.bs-band--agent { color: color-mix(in srgb, var(--color-verdict-ia) 72%, var(--foreground)); }
	.bs-limitation { line-height: 1.45; }
	.bs-sr-only {
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
	@media (prefers-reduced-motion: reduce) { .bs-button { transition: none; } }
</style>
