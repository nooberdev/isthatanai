<script lang="ts">
	// Calibración (Etapa 4/5): medidas en tiempo real + grabador de sesiones.
	// Subcomponente de DevPanel; solo se renderiza en desarrollo.
	import type {
		ClickSample,
		InputSample,
		KeySample,
		MouseFeatures,
		PointerSample,
		ScrollSample,
		SignalScores
	} from "is-that-an-ai";
	import { live } from "#lib/detector/live.svelte";
	import { tr, type DemoTranslationKey } from "#lib/i18n";

	let {
		getRecentPoints,
		getRecentClicks,
		getRecentScrolls,
		getRecentKeys,
		getRecentInputs
	}: {
		getRecentPoints: (sinceSeq?: number) => PointerSample[];
		getRecentClicks: (sinceSeq?: number) => ClickSample[];
		getRecentScrolls: (sinceSeq?: number) => ScrollSample[];
		getRecentKeys: (sinceSeq?: number) => KeySample[];
		getRecentInputs: (sinceSeq?: number) => InputSample[];
	} = $props();

	type RecLabel = "humano" | "bot";

	interface Snapshot {
		t: number;
		score: number | null;
		features: MouseFeatures | null;
		signalScores: SignalScores;
	}

	interface ExportPayload {
		version: 1;
		label: RecLabel;
		startedAt: string;
		endedAt: string;
		durationMs: number;
		sampleCount: number;
		samples: PointerSample[];
		clicks: ClickSample[];
		scrolls: ScrollSample[];
		keys: KeySample[];
		inputs: InputSample[];
		snapshots: Snapshot[];
	}

	const MEASURES: Array<{ key: keyof MouseFeatures; labelKey: DemoTranslationKey }> = [
		{ key: "straightness", labelKey: "calib.measure.straightness" },
		{ key: "teleport", labelKey: "calib.measure.teleport" },
		{ key: "speedUniformity", labelKey: "calib.measure.speedUniformity" },
		{ key: "jerk", labelKey: "calib.measure.jerk" },
		{ key: "tremor", labelKey: "calib.measure.tremor" },
		{ key: "intervalRegularity", labelKey: "calib.measure.intervalRegularity" },
		{ key: "overshoot", labelKey: "calib.measure.overshoot" },
		{ key: "turnSmoothness", labelKey: "calib.measure.turnSmoothness" },
		{ key: "microPauses", labelKey: "calib.measure.microPauses" },
		{ key: "roundSteps", labelKey: "calib.measure.roundSteps" }
	];

	// ---- Medidas: leídas del sondeo compartido ----
	let features = $derived(live.features);

	// ---- Grabador ----
	let recording = $state(false);
	let label = $state<RecLabel>("humano");
	let startedAtMs = $state(0);
	let endedAtMs = $state(0);
	let durationMs = $state(0);
	let lastSeq = 0;
	let lastClickSeq = 0;
	let lastScrollSeq = 0;
	let lastKeySeq = 0;
	let lastInputSeq = 0;
	let samples = $state<PointerSample[]>([]);
	let clicks = $state<ClickSample[]>([]);
	let scrolls = $state<ScrollSample[]>([]);
	let keys = $state<KeySample[]>([]);
	let inputs = $state<InputSample[]>([]);
	let snapshots = $state<Snapshot[]>([]);
	let sampleTimer: ReturnType<typeof setInterval> | null = null;
	let snapshotTimer: ReturnType<typeof setInterval> | null = null;

	let statusText = $derived(
		recording
			? tr("calib.recording", { label: tr(label === "bot" ? "calib.label.bot" : "calib.label.human") })
			: tr("calib.stopped")
	);
	let durationLabel = $derived(`${(durationMs / 1000).toFixed(1)} s`);
	let sampleLabel = $derived(tr("recorder.count.samples", { count: samples.length }));

	function onSamplesTick(): void {
		const pts = getRecentPoints(lastSeq);
		if (pts.length > 0) {
			for (const p of pts) {
				samples.push(p);
			}
			lastSeq = pts[pts.length - 1].seq;
		}
		const clicksSince = getRecentClicks(lastClickSeq);
		if (clicksSince.length > 0) {
			for (const c of clicksSince) {
				clicks.push(c);
			}
			lastClickSeq = clicksSince[clicksSince.length - 1].seq;
		}
		const scrollsSince = getRecentScrolls(lastScrollSeq);
		if (scrollsSince.length > 0) {
			for (const s of scrollsSince) {
				scrolls.push(s);
			}
			lastScrollSeq = scrollsSince[scrollsSince.length - 1].seq;
		}
		const keysSince = getRecentKeys(lastKeySeq);
		if (keysSince.length > 0) {
			for (const k of keysSince) {
				keys.push(k);
			}
			lastKeySeq = keysSince[keysSince.length - 1].seq;
		}
		const inputsSince = getRecentInputs(lastInputSeq);
		if (inputsSince.length > 0) {
			for (const i of inputsSince) {
				inputs.push(i);
			}
			lastInputSeq = inputsSince[inputsSince.length - 1].seq;
		}
	}

	function onSnapshotTick(): void {
		durationMs = Date.now() - startedAtMs;
		snapshots.push({
			t: Date.now(),
			score: live.verdict.score,
			features: live.features,
			signalScores: live.scores
		});
	}

	function startRecording(recLabel: RecLabel): void {
		if (recording) return;
		label = recLabel;
		recording = true;
		startedAtMs = Date.now();
		endedAtMs = startedAtMs;
		durationMs = 0;
		samples = [];
		clicks = [];
		scrolls = [];
		keys = [];
		inputs = [];
		snapshots = [];
		lastSeq = 0;
		lastClickSeq = 0;
		lastScrollSeq = 0;
		lastKeySeq = 0;
		lastInputSeq = 0;
		// Solo muestras nuevas: saltamos lo que ya existía en cada buffer.
		const existing = getRecentPoints(0);
		if (existing.length > 0) lastSeq = existing[existing.length - 1].seq;
		const existingClicks = getRecentClicks(0);
		if (existingClicks.length > 0) lastClickSeq = existingClicks[existingClicks.length - 1].seq;
		const existingScrolls = getRecentScrolls(0);
		if (existingScrolls.length > 0) lastScrollSeq = existingScrolls[existingScrolls.length - 1].seq;
		const existingKeys = getRecentKeys(0);
		if (existingKeys.length > 0) lastKeySeq = existingKeys[existingKeys.length - 1].seq;
		const existingInputs = getRecentInputs(0);
		if (existingInputs.length > 0) lastInputSeq = existingInputs[existingInputs.length - 1].seq;
		sampleTimer = setInterval(onSamplesTick, 100);
		snapshotTimer = setInterval(onSnapshotTick, 250);
	}

	function stopRecording(): void {
		if (!recording) return;
		recording = false;
		endedAtMs = Date.now();
		durationMs = endedAtMs - startedAtMs;
		if (sampleTimer) {
			clearInterval(sampleTimer);
			sampleTimer = null;
		}
		if (snapshotTimer) {
			clearInterval(snapshotTimer);
			snapshotTimer = null;
		}
	}

	function exportRecording(): void {
		const payload: ExportPayload = {
			version: 1,
			label,
			startedAt: new Date(startedAtMs).toISOString(),
			endedAt: new Date(endedAtMs).toISOString(),
			durationMs: endedAtMs - startedAtMs,
			sampleCount: samples.length,
			samples,
			clicks,
			scrolls,
			keys,
			inputs,
			snapshots
		};
		const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `isthatanai-${payload.label}-${payload.startedAt}.json`;
		a.click();
		URL.revokeObjectURL(url);
	}
</script>

<section class="cp-section">
	<h3 class="cp-title">{tr("calib.measures")}</h3>
	<dl class="cp-measures">
		{#each MEASURES as m (m.key)}
			<div class="cp-measure">
				<dt class="cp-measure-label">{tr(m.labelKey)}</dt>
				<dd class="cp-measure-value">{features ? features[m.key].toFixed(2) : "—"}</dd>
				<div class="cp-bar">
					<div class="cp-bar-fill" style={features ? `width: ${features[m.key] * 100}%` : "width: 0%"}></div>
				</div>
			</div>
		{/each}
	</dl>
</section>

<section class="cp-section">
	<h3 class="cp-title">{tr("calib.recorder")}</h3>
	<div class="cp-recorder">
		<button type="button" class="cp-btn" onclick={() => startRecording("humano")}>
			{tr("calib.button.human")}
		</button>
		<button type="button" class="cp-btn" onclick={() => startRecording("bot")}>{tr("calib.button.bot")}</button>
		<button type="button" class="cp-btn" onclick={stopRecording} disabled={!recording}>{tr("calib.button.stop")}</button>
		<button type="button" class="cp-btn" onclick={exportRecording} disabled={recording || samples.length === 0}>
			{tr("calib.button.export")}
		</button>
	</div>
	<p class="cp-status">{tr("calib.status", { status: statusText, duration: durationLabel, samples: sampleLabel })}</p>
</section>

<style>
	.cp-section {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		padding-top: 0.5rem;
		border-top: 1px solid var(--border);
	}

	.cp-title {
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--foreground);
		margin: 0;
	}

	.cp-measures {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		margin: 0;
	}

	.cp-measure {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}

	.cp-measure-label {
		font-size: 0.6875rem;
		color: var(--muted-foreground);
		margin: 0;
	}

	.cp-measure-value {
		font-size: 0.75rem;
		font-variant-numeric: tabular-nums;
		margin: 0;
	}

	.cp-bar {
		height: 2px;
		border-radius: 9999px;
		background: var(--border);
		overflow: hidden;
	}

	.cp-bar-fill {
		height: 100%;
		border-radius: 9999px;
		background: var(--foreground);
		opacity: 0.75;
		transition: width var(--dur-180);
	}

	.cp-recorder {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.cp-btn {
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--card);
		color: var(--foreground);
		padding: 0.3rem 0.6rem;
		font-size: 0.75rem;
		cursor: pointer;
		transition: background-color var(--dur-180), color var(--dur-180);
	}

	.cp-btn:hover:not(:disabled) {
		background: var(--accent);
	}

	.cp-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.cp-status {
		font-size: 0.6875rem;
		color: var(--muted-foreground);
		margin: 0;
	}
</style>
