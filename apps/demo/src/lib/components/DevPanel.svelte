<script lang="ts">
	import type {
		ClickSample,
		CollectorStats,
		InputSample,
		KeySample,
		MouseFeatures,
		PointerSample,
		ScrollSample,
		Verdict
	} from "is-that-an-ai";
	import type { VerdictState } from "#lib/motion/verdict.svelte";
	import CalibrationPanel from "#lib/components/CalibrationPanel.svelte";

	// Forma estructural de las señales (una por señal, null sin evidencia).
	interface SignalScores {
		mouse: number | null;
		keyboard: number | null;
		click: number | null;
		scroll: number | null;
	}

	let {
		currentState,
		onSetState,
		getStats,
		getVerdict,
		getMouseFeatures,
		getRecentPoints,
		getSignalScores,
		getRecentClicks,
		getRecentScrolls,
		getRecentKeys,
		getRecentInputs,
		forced = false
	}: {
		currentState: VerdictState;
		onSetState: (s: VerdictState) => void;
		getStats: () => CollectorStats;
		getVerdict: () => Verdict;
		getMouseFeatures: () => MouseFeatures | null;
		getRecentPoints: (sinceSeq?: number) => PointerSample[];
		getSignalScores: () => SignalScores;
		getRecentClicks: (sinceSeq?: number) => ClickSample[];
		getRecentScrolls: (sinceSeq?: number) => ScrollSample[];
		getRecentKeys: (sinceSeq?: number) => KeySample[];
		getRecentInputs: (sinceSeq?: number) => InputSample[];
		forced?: boolean;
	} = $props();

	let open = $state(false);
	let stats = $state<CollectorStats | null>(null);
	let verdict = $state<Verdict | null>(null);
	let signalScores = $state<SignalScores | null>(null);

	function setState(s: VerdictState): void {
		onSetState(s);
		open = false;
	}

	// Etiquetas de la demo (currentState) y de la librería (verdict.state).
	const STATE_WORD: Record<VerdictState, string> = {
		midiendo: "MIDIENDO",
		humano: "HUMANO",
		ia: "AGENTE"
	};

	const LIB_WORD: Record<string, string> = {
		measuring: "MIDIENDO",
		human: "HUMANO",
		ai: "AGENTE"
	};

	function verdictWord(state: string | undefined): string {
		if (!state) return "MIDIENDO";
		return LIB_WORD[state] ?? "MIDIENDO";
	}

	// Panel mínimo para revisar las animaciones sin la librería real.
	// Solo existe en desarrollo; se abre con la tecla D.
	$effect(() => {
		if (!import.meta.env.DEV) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.repeat) return;
			const target = e.target;
			if (target instanceof HTMLElement && (target.isContentEditable || target.matches("input, textarea, select"))) {
				return;
			}
			if (e.key.toLowerCase() === "d") {
				e.preventDefault();
				open = !open;
			} else if (e.key === "Escape") {
				open = false;
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	});

	// Solo mientras el panel está abierto: refresco ~4 veces por segundo.
	$effect(() => {
		if (!open || !import.meta.env.DEV) return;
		const refresh = () => {
			stats = getStats();
			verdict = getVerdict();
			signalScores = getSignalScores();
		};
		refresh();
		const id = setInterval(refresh, 250);
		return () => clearInterval(id);
	});
</script>

{#if import.meta.env.DEV}
	{#if open}
		<div class="dev-panel" role="dialog" aria-label="Panel de desarrollo">
			<p class="dev-panel__status">Estado actual: {STATE_WORD[currentState]}</p>
			<div class="dev-panel__section">
				<p class="dev-panel__title">Recolector</p>
				<dl class="dev-panel__stats">
					<div class="dev-panel__row">
						<dt>Muestras</dt>
						<dd>{stats?.sampleCount ?? 0}</dd>
					</div>
					<div class="dev-panel__row">
						<dt>Clics</dt>
						<dd>{stats?.clickCount ?? 0}</dd>
					</div>
					<div class="dev-panel__row">
						<dt>Scroll</dt>
						<dd>{stats?.scrollCount ?? 0}</dd>
					</div>
					<div class="dev-panel__row">
						<dt>Teclas</dt>
						<dd>{stats?.keyCount ?? 0}</dd>
					</div>
					<div class="dev-panel__row">
						<dt>Inputs</dt>
						<dd>{stats?.inputCount ?? 0}</dd>
					</div>
					<div class="dev-panel__row">
						<dt>Eventos/s</dt>
						<dd>{(stats?.eventsPerSecond ?? 0).toFixed(1)}</dd>
					</div>
					<div class="dev-panel__row">
						<dt>Buffer</dt>
						<dd>{Math.round((stats?.bufferFill ?? 0) * 100)}%</dd>
					</div>
					<div class="dev-panel__row">
						<dt>Confiables</dt>
						<dd>{Math.round((stats?.trustedRatio ?? 0) * 100)}%</dd>
					</div>
				</dl>
			</div>
			<div class="dev-panel__section">
				<p class="dev-panel__title">Veredicto</p>
				<dl class="dev-panel__stats">
					<div class="dev-panel__row">
						<dt>Estado</dt>
						<dd>{verdictWord(verdict?.state)}</dd>
					</div>
					<div class="dev-panel__row">
						<dt>Score</dt>
						<dd>{verdict && verdict.score !== null ? verdict.score.toFixed(2) : "—"}</dd>
					</div>
					<div class="dev-panel__row">
						<dt>Confianza</dt>
						<dd>{Math.round((verdict?.confidence ?? 0) * 100)}%</dd>
					</div>
					<div class="dev-panel__row">
						<dt>Duda</dt>
						<dd>{Math.round((verdict?.doubt ?? 0) * 100)}%</dd>
					</div>
				</dl>
				{#if verdict && verdict.reasons.length > 0}
					<ul class="dev-panel__reasons">
						{#each verdict.reasons.slice(0, 3) as reason}
							<li>{reason}</li>
						{/each}
					</ul>
				{/if}
				{#if forced}
					<p class="dev-panel__forced">estado forzado por demo</p>
				{/if}
				<div class="dev-panel__signals">
					<p class="dev-panel__title">Señales</p>
					<dl class="dev-panel__stats">
						<div class="dev-panel__row">
							<dt>Mouse</dt>
							<dd>{signalScores && signalScores.mouse !== null ? signalScores.mouse.toFixed(2) : "—"}</dd>
						</div>
						<div class="dev-panel__row">
							<dt>Teclado</dt>
							<dd>{signalScores && signalScores.keyboard !== null ? signalScores.keyboard.toFixed(2) : "—"}</dd>
						</div>
						<div class="dev-panel__row">
							<dt>Clic</dt>
							<dd>{signalScores && signalScores.click !== null ? signalScores.click.toFixed(2) : "—"}</dd>
						</div>
						<div class="dev-panel__row">
							<dt>Scroll</dt>
							<dd>{signalScores && signalScores.scroll !== null ? signalScores.scroll.toFixed(2) : "—"}</dd>
						</div>
					</dl>
				</div>
			</div>
			<CalibrationPanel
				getMouseFeatures={getMouseFeatures}
				getRecentPoints={getRecentPoints}
				getVerdict={getVerdict}
				getSignalScores={getSignalScores}
				getRecentClicks={getRecentClicks}
				getRecentScrolls={getRecentScrolls}
				getRecentKeys={getRecentKeys}
				getRecentInputs={getRecentInputs}
			/>
		<div class="dev-panel__actions">
				<button type="button" class="dev-panel__btn" onclick={() => setState("midiendo")}>midiendo</button>
				<button type="button" class="dev-panel__btn" onclick={() => setState("humano")}>humano</button>
				<button type="button" class="dev-panel__btn" onclick={() => setState("ia")}>AGENTE</button>
				<button type="button" class="dev-panel__btn" onclick={() => (open = false)}>Cerrar</button>
			</div>
		</div>
	{/if}
{/if}

<style>
	.dev-panel {
		position: fixed;
		right: 1rem;
		bottom: 3.5rem;
		z-index: 60;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.875rem 1rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--background);
		color: var(--foreground);
	}

	.dev-panel__status {
		font-size: 0.75rem;
		color: var(--muted-foreground);
	}

	.dev-panel__section {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		padding-top: 0.5rem;
		border-top: 1px solid var(--border);
	}

	.dev-panel__title {
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--foreground);
	}

	.dev-panel__stats {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		margin: 0;
	}

	.dev-panel__row {
		display: flex;
		justify-content: space-between;
		gap: 1.25rem;
		font-size: 0.75rem;
	}

	.dev-panel__row dt {
		color: var(--muted-foreground);
	}

	.dev-panel__row dd {
		margin: 0;
		font-variant-numeric: tabular-nums;
	}

	.dev-panel__reasons {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		margin: 0;
		padding-left: 1rem;
		font-size: 0.75rem;
		color: var(--muted-foreground);
	}

	.dev-panel__forced {
		margin: 0;
		font-size: 0.75rem;
		color: var(--muted-foreground);
	}

	.dev-panel__signals {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		margin-top: 0.35rem;
	}

	.dev-panel__actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.dev-panel__btn {
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--card);
		color: var(--foreground);
		padding: 0.35rem 0.625rem;
		font-size: 0.75rem;
		cursor: pointer;
		transition: background-color var(--dur-180), color var(--dur-180);
	}

	.dev-panel__btn:hover {
		background: var(--accent);
	}
</style>
