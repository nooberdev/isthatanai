<script lang="ts">
	// Grabación en memoria de instantáneas del detector en vivo. Exportación e
	// importación locales: ni red, ni localStorage, ni cookies, ni subida.

	import type {
		ClickSample,
		InputSample,
		IsThatAnAI,
		KeySample,
		PointerSample,
		ScrollSample
	} from "is-that-an-ai";
	import {
		createSession,
		emptySnapshot,
		parseSession,
		serializeSession,
		summarize,
		type SessionRecord,
		type SessionSnapshot
	} from "#lib/lab/session";
	import { live } from "#lib/detector/live.svelte";
	import { tr, type DemoTranslationKey, type TranslationParams } from "#lib/i18n";

	let {
		getRecentPoints,
		getRecentClicks,
		getRecentScrolls,
		getRecentKeys,
		getRecentInputs,
		detector = null,
		session,
		onSession
	}: {
		getRecentPoints: (sinceSeq?: number) => PointerSample[];
		getRecentClicks: (sinceSeq?: number) => ClickSample[];
		getRecentScrolls: (sinceSeq?: number) => ScrollSample[];
		getRecentKeys: (sinceSeq?: number) => KeySample[];
		getRecentInputs: (sinceSeq?: number) => InputSample[];
		detector?: IsThatAnAI | null;
		session: SessionRecord | null;
		onSession: (next: SessionRecord | null) => void;
	} = $props();

	// La librería puede no tener aún estos métodos en un build anterior: se
	// comprueba en tiempo de ejecución y nunca se inventa un resultado.
	type CalibrationResult = {
		applied: boolean;
		samples: number;
		adjustments: Record<string, number>;
		reasons: string[];
	};
	type CalibrationDetector = IsThatAnAI & {
		recalibrateFromSession?(session: unknown): unknown;
		getCalibration?(): unknown;
		resetCalibration?(): void;
	};

	let recording = $state(false);
	let calibration = $state<CalibrationResult | null>(null);
	let draft = $state<SessionSnapshot>(emptySnapshot());
	let lastSeq = { points: 0, clicks: 0, scrolls: 0, keys: 0, inputs: 0 };
	// La nota guarda su clave, no el texto: así sigue al idioma al cambiarlo.
	type Note = { key: DemoTranslationKey; params?: TranslationParams };
	let noteState = $state<Note>({ key: "recorder.note.initial" });
	let note = $derived(tr(noteState.key, noteState.params));
	function say(key: DemoTranslationKey, params?: TranslationParams): void {
		noteState = { key, params };
	}

	function isObject(value: unknown): value is Record<string, unknown> {
		return value !== null && typeof value === "object" && !Array.isArray(value);
	}

	/** Solo publicamos un resultado con la forma prometida; el resto se descarta. */
	function readCalibration(value: unknown): CalibrationResult | null {
		if (!isObject(value) || typeof value.applied !== "boolean") return null;
		if (typeof value.samples !== "number" || !Number.isFinite(value.samples)) return null;
		const adjustments: Record<string, number> = {};
		if (isObject(value.adjustments)) {
			for (const [key, amount] of Object.entries(value.adjustments)) {
				if (typeof amount === "number" && Number.isFinite(amount)) adjustments[key] = amount;
			}
		}
		const reasons = Array.isArray(value.reasons)
			? value.reasons.filter(
					(reason): reason is string => typeof reason === "string" && reason.trim() !== ""
				)
			: [];
		return {
			applied: value.applied,
			samples: Math.max(0, Math.floor(value.samples)),
			adjustments,
			reasons
		};
	}

	$effect(() => {
		const d = detector as CalibrationDetector | null;
		calibration =
			d && typeof d.getCalibration === "function" ? readCalibration(d.getCalibration()) : null;
	});

	const canCalibrate = $derived(
		session !== null &&
			summarize(session).total > 0 &&
			detector !== null &&
			typeof (detector as CalibrationDetector).recalibrateFromSession === "function"
	);
	const canReset = $derived(
		calibration !== null &&
			detector !== null &&
			typeof (detector as CalibrationDetector).resetCalibration === "function"
	);

	function recalibrate(): void {
		const d = detector as CalibrationDetector | null;
		if (!d || typeof d.recalibrateFromSession !== "function") {
			say("recorder.calibration.unavailable");
			return;
		}
		if (!session || summarize(session).total === 0) {
			say("recorder.calibration.note.none");
			return;
		}
		let raw: unknown;
		try {
			// El registro en memoria es el JSON de la sesión grabada o importada.
			raw = d.recalibrateFromSession(session);
		} catch (error) {
			say("recorder.calibration.failed", {
				error: error instanceof Error ? error.message : tr("recorder.calibration.invalid")
			});
			return;
		}
		const result = readCalibration(raw);
		if (!result) {
			calibration = null;
			say("recorder.calibration.invalid");
			return;
		}
		calibration = result;
		say(
			result.applied ? "recorder.calibration.note.applied" : "recorder.calibration.note.skipped",
			{ samples: result.samples }
		);
		live.pump();
	}

	function resetCalibration(): void {
		const d = detector as CalibrationDetector | null;
		if (!d || typeof d.resetCalibration !== "function") {
			say("recorder.calibration.unavailable");
			return;
		}
		try {
			d.resetCalibration();
		} catch (error) {
			say("recorder.calibration.failed", {
				error: error instanceof Error ? error.message : tr("recorder.calibration.invalid")
			});
			return;
		}
		calibration = null;
		say("recorder.calibration.note.reset");
		live.pump();
	}

	// Igual que antes: stats y verdict se refrescan solo mientras se graba,
	// ahora leyendo el sondeo compartido en vez de llamar a los getters.
	let stats = $state(live.stats);
	let verdict = $state(live.verdict);

	function append<K extends keyof SessionSnapshot>(key: K, items: SessionSnapshot[K]): void {
		if (items.length === 0) return;
		lastSeq[key] = (items[items.length - 1] as { seq: number }).seq;
		(draft[key] as unknown[]).push(...items);
	}

	function collect(): void {
		append("points", getRecentPoints(lastSeq.points));
		append("clicks", getRecentClicks(lastSeq.clicks));
		append("scrolls", getRecentScrolls(lastSeq.scrolls));
		append("keys", getRecentKeys(lastSeq.keys));
		append("inputs", getRecentInputs(lastSeq.inputs));
		stats = live.stats;
		verdict = live.verdict;
	}

	$effect(() => {
		if (!recording) return;
		collect();
		const id = setInterval(collect, 200);
		return () => clearInterval(id);
	});

	function durationOf(snapshot: SessionSnapshot): number {
		let min = Infinity;
		let max = -Infinity;
		for (const items of [
			snapshot.points,
			snapshot.clicks,
			snapshot.scrolls,
			snapshot.keys,
			snapshot.inputs
		]) {
			for (const item of items) {
				min = Math.min(min, item.t);
				max = Math.max(max, item.t);
			}
		}
		return Number.isFinite(min) && max >= min ? max - min : 0;
	}

	function start(): void {
		draft = emptySnapshot();
		lastSeq = { points: 0, clicks: 0, scrolls: 0, keys: 0, inputs: 0 };
		say("recorder.note.recording");
		recording = true;
	}

	function stop(): void {
		collect();
		recording = false;
		const total =
			draft.points.length +
			draft.clicks.length +
			draft.scrolls.length +
			draft.keys.length +
			draft.inputs.length;
		if (total === 0) {
			say("recorder.note.empty");
			return;
		}
		onSession(createSession(draft, durationOf(draft)));
		say("recorder.note.saved");
	}

	function clear(): void {
		onSession(null);
		say("recorder.note.cleared");
	}

	function exportJson(): void {
		const record = session ?? createSession(draft, durationOf(draft));
		if (summarize(record).total === 0) {
			say("recorder.note.nothing");
			return;
		}
		const blob = new Blob([serializeSession(record)], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = `sesion-${new Date().toISOString().slice(0, 19)}.json`;
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
		say("recorder.note.downloaded");
	}

	async function importJson(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		try {
			const record = parseSession(await file.text());
			onSession(record);
			say("recorder.note.imported", {
				name: file.name,
				count: summarize(record).total
			});
		} catch (error) {
			say("recorder.note.failed", {
				error: error instanceof Error ? error.message : tr("recorder.fileUnreadable")
			});
		}
		input.value = "";
	}

	const draftTotal = $derived(
		draft.points.length +
			draft.clicks.length +
			draft.scrolls.length +
			draft.keys.length +
			draft.inputs.length
	);
	const summary = $derived(
		session
			? summarize(session)
			: {
					points: draft.points.length,
					clicks: draft.clicks.length,
					scrolls: draft.scrolls.length,
					keys: draft.keys.length,
					inputs: draft.inputs.length,
					total: draftTotal,
					durationMs: durationOf(draft)
				}
	);
	const verdictLabel = $derived(
		verdict.state === "ai"
			? tr("label.ai")
			: verdict.state === "human"
				? tr("label.human")
				: tr("label.measuring")
	);
</script>

<section class="section rec-section" aria-labelledby="rec-title">
	<div class="rec-content">
		<h2 id="rec-title" class="section-title">{tr("recorder.title")}</h2>
		<p class="section-body">
			{tr("recorder.body1")}<br />
			{tr("recorder.body2")}
		</p>

		<div class="rec-grid">
			<div class="rec-card">
				<div class="rec-card-head">
					<h3 class="rec-card-title">{tr("recorder.card.recorder")}</h3>
					<p class="rec-meta">
						{tr("recorder.meta", {
							state: recording ? tr("recorder.state.recording") : tr("recorder.state.stopped"),
							samples: stats.sampleCount,
							keys: stats.keyCount,
							verdict: verdictLabel
						})}
					</p>
				</div>
				<div class="rec-actions">
					{#if recording}
						<button type="button" class="rec-button" onclick={stop}>{tr("recorder.button.stop")}</button>
					{:else}
						<button type="button" class="rec-button" onclick={start}>{tr("recorder.button.start")}</button>
					{/if}
					<button type="button" class="rec-button rec-button--quiet" onclick={exportJson}>
						{tr("recorder.button.export")}
					</button>
					<label class="rec-file">
						{tr("recorder.button.import")}
						<input type="file" accept="application/json,.json" onchange={importJson} />
					</label>
				</div>
				<div class="rec-counts">
					<span><strong>{summary.total}</strong> {tr("recorder.unit.samples")}</span>
					<span><strong>{(summary.durationMs / 1000).toFixed(1)}</strong> s</span>
					<span><strong>{stats.droppedCount}</strong> {tr("recorder.unit.discarded")}</span>
				</div>
				<p class="rec-note" aria-live="polite">{note}</p>
			</div>

			<div class="rec-card">
				<div class="rec-card-head">
					<h3 class="rec-card-title">{tr("recorder.card.session")}</h3>
					<p class="rec-meta">
						{session
							? session.source === "importada"
								? tr("recorder.source.imported")
								: tr("recorder.source.recorded")
							: tr("recorder.source.none")}
					</p>
				</div>
				<table>
					<caption class="rec-sr-only">{tr("recorder.caption")}</caption>
					<tbody>
						<tr><th scope="row">{tr("recorder.th.pointer")}</th><td>{summary.points}</td></tr>
						<tr><th scope="row">{tr("recorder.th.clicks")}</th><td>{summary.clicks}</td></tr>
						<tr><th scope="row">{tr("recorder.th.scroll")}</th><td>{summary.scrolls}</td></tr>
						<tr><th scope="row">{tr("recorder.th.keyboard")}</th><td>{summary.keys}</td></tr>
						<tr><th scope="row">{tr("recorder.th.text")}</th><td>{summary.inputs}</td></tr>
						<tr><th scope="row">{tr("recorder.th.duration")}</th><td>{(summary.durationMs / 1000).toFixed(1)} s</td></tr>
					</tbody>
				</table>
				{#if session}
					<p class="rec-meta">{tr("recorder.recorded", { date: session.recordedAt })}</p>
				{/if}
				<button
					type="button"
					class="rec-button rec-button--quiet"
					disabled={!session}
					onclick={clear}
				>
					{tr("recorder.button.clear")}
				</button>
				<div class="rec-calibration">
					<h4 class="rec-calibration-title">{tr("recorder.calibration.title")}</h4>
					<p class="rec-meta">{tr("recorder.calibration.note")}</p>
					<div class="rec-actions">
						<button
							type="button"
							class="rec-button"
							disabled={!canCalibrate}
							onclick={recalibrate}
						>
							{tr("recorder.calibration.button")}
						</button>
						<button
							type="button"
							class="rec-button rec-button--quiet"
							disabled={!canReset}
							onclick={resetCalibration}
						>
							{tr("recorder.calibration.reset")}
						</button>
					</div>
					{#if calibration}
						<div class="rec-calibration-result" aria-live="polite">
							<p class="rec-meta">
								{tr("recorder.calibration.result", {
									applied: tr(calibration.applied ? "yes" : "no"),
									samples: calibration.samples
								})}
							</p>
							{#if Object.keys(calibration.adjustments).length > 0}
								<p class="rec-meta">{tr("recorder.calibration.adjustments")}</p>
								<ul class="rec-calibration-list">
									{#each Object.entries(calibration.adjustments) as [key, amount] (key)}
										<li><span>{key}</span><strong>{amount.toFixed(3)}</strong></li>
									{/each}
								</ul>
							{/if}
							<p class="rec-meta">
								{tr("recorder.calibration.reasons")}:
								{calibration.reasons.length > 0
									? calibration.reasons.join(" · ")
									: tr("recorder.calibration.reasons.empty")}
							</p>
						</div>
					{/if}
				</div>
			</div>
		</div>

		<p class="rec-footnote">{tr("recorder.footnote")}</p>
	</div>
</section>

<style>
	.rec-section { gap: 1rem; }
	.rec-content {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.9rem;
		width: min(60rem, 100%);
	}
	.rec-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.75rem;
		width: 100%;
	}
	.rec-card {
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
	.rec-card-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.4rem 0.75rem;
	}
	.rec-card-title { margin: 0; font-size: 0.8125rem; font-weight: 600; }
	.rec-meta, .rec-note, .rec-footnote {
		margin: 0;
		font-size: 0.6875rem;
		color: var(--muted-foreground);
		line-height: 1.5;
	}
	.rec-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; }
	.rec-button, .rec-file {
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
	.rec-button:hover:not(:disabled), .rec-file:hover { background: var(--accent); }
	.rec-button--quiet { background: transparent; }
	.rec-button:disabled { opacity: 0.5; cursor: not-allowed; }
	.rec-button:focus-visible, .rec-file:focus-within {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}
	.rec-file { display: inline-flex; align-items: center; }
	.rec-file input { max-width: 11rem; font: inherit; font-size: 0.625rem; }
	.rec-counts { display: flex; flex-wrap: wrap; gap: 0.9rem; font-size: 0.6875rem; }
	.rec-counts strong { font-variant-numeric: tabular-nums; }
	table { width: 100%; border-collapse: collapse; font-size: 0.75rem; }
	caption { text-align: left; }
	th, td { padding: 0.2rem 0.45rem; border-bottom: 1px solid var(--border); text-align: left; }
	tbody th { font-weight: 400; color: var(--muted-foreground); }
	tbody td { text-align: right; font-variant-numeric: tabular-nums; }
	.rec-calibration {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		padding-top: 0.55rem;
		border-top: 1px solid var(--border);
	}
	.rec-calibration-title { margin: 0; font-size: 0.75rem; font-weight: 600; }
	.rec-calibration-result { display: flex; flex-direction: column; gap: 0.25rem; }
	.rec-calibration-list {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
		gap: 0.15rem 0.75rem;
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: 0.625rem;
	}
	.rec-calibration-list li {
		display: flex;
		justify-content: space-between;
		gap: 0.4rem;
		min-width: 0;
	}
	.rec-calibration-list span { min-width: 0; color: var(--muted-foreground); overflow-wrap: anywhere; }
	.rec-calibration-list strong { flex: none; font-weight: 600; font-variant-numeric: tabular-nums; }
	.rec-sr-only {
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
	@media (max-width: 900px) { .rec-grid { grid-template-columns: minmax(0, 1fr); } }
	@media (prefers-reduced-motion: reduce) {
		.rec-button, .rec-file { transition: none; }
	}
</style>
