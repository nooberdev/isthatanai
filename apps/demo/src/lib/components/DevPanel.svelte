<script lang="ts">
	import type {
		ClickSample,
		InputSample,
		KeySample,
		PointerSample,
		ScrollSample
	} from "is-that-an-ai";
	import type { VerdictState } from "#lib/motion/verdict.svelte";
	import CalibrationPanel from "#lib/components/CalibrationPanel.svelte";
	import { live } from "#lib/detector/live.svelte";
	import { tr, type DemoTranslationKey } from "#lib/i18n";

	let {
		currentState,
		onSetState,
		getRecentPoints,
		getRecentClicks,
		getRecentScrolls,
		getRecentKeys,
		getRecentInputs,
		forced = false
	}: {
		currentState: VerdictState;
		onSetState: (s: VerdictState) => void;
		getRecentPoints: (sinceSeq?: number) => PointerSample[];
		getRecentClicks: (sinceSeq?: number) => ClickSample[];
		getRecentScrolls: (sinceSeq?: number) => ScrollSample[];
		getRecentKeys: (sinceSeq?: number) => KeySample[];
		getRecentInputs: (sinceSeq?: number) => InputSample[];
		forced?: boolean;
	} = $props();

	let open = $state(false);
	// Leídos del sondeo compartido; el panel solo existe en desarrollo.
	let stats = $derived(live.stats);
	let verdict = $derived(live.verdict);
	let signalScores = $derived(live.scores);

	function setState(s: VerdictState): void {
		onSetState(s);
		open = false;
	}

	// Etiquetas de la demo (currentState) y de la librería (verdict.state).
	const STATE_WORD_KEY: Record<VerdictState, DemoTranslationKey> = {
		midiendo: "word.measuring",
		humano: "word.human",
		ia: "word.ai"
	};

	const LIB_WORD_KEY: Record<string, DemoTranslationKey> = {
		measuring: "word.measuring",
		human: "word.human",
		ai: "word.ai"
	};

	function verdictWord(state: string | undefined): string {
		return tr(state ? (LIB_WORD_KEY[state] ?? "word.measuring") : "word.measuring");
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

</script>

{#if import.meta.env.DEV}
	{#if open}
		<div class="dev-panel" role="dialog" aria-label={tr("dev.dialog.aria")}>
			<p class="dev-panel__status">{tr("dev.status", { state: tr(STATE_WORD_KEY[currentState]) })}</p>
			<div class="dev-panel__section">
				<p class="dev-panel__title">{tr("dev.collector")}</p>
				<dl class="dev-panel__stats">
					<div class="dev-panel__row">
						<dt>{tr("dev.dt.samples")}</dt>
						<dd>{stats?.sampleCount ?? 0}</dd>
					</div>
					<div class="dev-panel__row">
						<dt>{tr("dev.dt.clicks")}</dt>
						<dd>{stats?.clickCount ?? 0}</dd>
					</div>
					<div class="dev-panel__row">
						<dt>{tr("dev.dt.scroll")}</dt>
						<dd>{stats?.scrollCount ?? 0}</dd>
					</div>
					<div class="dev-panel__row">
						<dt>{tr("dev.dt.keys")}</dt>
						<dd>{stats?.keyCount ?? 0}</dd>
					</div>
					<div class="dev-panel__row">
						<dt>{tr("dev.dt.inputs")}</dt>
						<dd>{stats?.inputCount ?? 0}</dd>
					</div>
					<div class="dev-panel__row">
						<dt>{tr("dev.dt.events")}</dt>
						<dd>{(stats?.eventsPerSecond ?? 0).toFixed(1)}</dd>
					</div>
					<div class="dev-panel__row">
						<dt>{tr("dev.dt.buffer")}</dt>
						<dd>{Math.round((stats?.bufferFill ?? 0) * 100)}%</dd>
					</div>
					<div class="dev-panel__row">
						<dt>{tr("dev.dt.trusted")}</dt>
						<dd>{Math.round((stats?.trustedRatio ?? 0) * 100)}%</dd>
					</div>
				</dl>
			</div>
			<div class="dev-panel__section">
				<p class="dev-panel__title">{tr("dev.verdict")}</p>
				<dl class="dev-panel__stats">
					<div class="dev-panel__row">
						<dt>{tr("dev.dt.state")}</dt>
						<dd>{verdictWord(verdict?.state)}</dd>
					</div>
					<div class="dev-panel__row">
						<dt>{tr("dev.dt.score")}</dt>
						<dd>{verdict && verdict.score !== null ? verdict.score.toFixed(2) : "—"}</dd>
					</div>
					<div class="dev-panel__row">
						<dt>{tr("dev.dt.confidence")}</dt>
						<dd>{Math.round((verdict?.confidence ?? 0) * 100)}%</dd>
					</div>
					<div class="dev-panel__row">
						<dt>{tr("dev.dt.doubt")}</dt>
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
					<p class="dev-panel__forced">{tr("dev.forced")}</p>
				{/if}
				<div class="dev-panel__signals">
					<p class="dev-panel__title">{tr("dev.signals")}</p>
					<dl class="dev-panel__stats">
						<div class="dev-panel__row">
							<dt>{tr("dev.dt.mouse")}</dt>
							<dd>{signalScores && signalScores.mouse !== null ? signalScores.mouse.toFixed(2) : "—"}</dd>
						</div>
						<div class="dev-panel__row">
							<dt>{tr("dev.dt.keyboard")}</dt>
							<dd>{signalScores && signalScores.keyboard !== null ? signalScores.keyboard.toFixed(2) : "—"}</dd>
						</div>
						<div class="dev-panel__row">
							<dt>{tr("dev.dt.click")}</dt>
							<dd>{signalScores && signalScores.click !== null ? signalScores.click.toFixed(2) : "—"}</dd>
						</div>
						<div class="dev-panel__row">
							<dt>{tr("dev.dt.scroll")}</dt>
							<dd>{signalScores && signalScores.scroll !== null ? signalScores.scroll.toFixed(2) : "—"}</dd>
						</div>
					</dl>
				</div>
			</div>
			<CalibrationPanel
				getRecentPoints={getRecentPoints}
				getRecentClicks={getRecentClicks}
				getRecentScrolls={getRecentScrolls}
				getRecentKeys={getRecentKeys}
				getRecentInputs={getRecentInputs}
			/>
		<div class="dev-panel__actions">
				<button type="button" class="dev-panel__btn" onclick={() => setState("midiendo")}>{tr("label.measuring")}</button>
				<button type="button" class="dev-panel__btn" onclick={() => setState("humano")}>{tr("label.human")}</button>
				<button type="button" class="dev-panel__btn" onclick={() => setState("ia")}>{tr("word.ai")}</button>
				<button type="button" class="dev-panel__btn" onclick={() => (open = false)}>{tr("dev.close")}</button>
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
