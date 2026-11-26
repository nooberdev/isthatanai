<script lang="ts">
	// Etapa 8 — el laboratorio: traza en vivo, perfiles sintéticos y resultados.
	// Las muestras sintéticas pasan por el colector público y por ScoreComputer:
	// el puntaje es medido con la librería, no estimado a mano. Nada se envía
	// ni se guarda fuera de memoria.

	import { onMount } from "svelte";
	import {
		AI_MIN,
		HUMAN_MAX,
		ScoreComputer,
		createMouseCollector,
		type PointerSample
	} from "is-that-an-ai";
	import { live } from "#lib/detector/live.svelte";
	import { tr, type DemoTranslationKey, type TranslationParams } from "#lib/i18n";

	const BAND_KEY: Record<Band, DemoTranslationKey> = {
		humano: "band.human",
		"zona media": "band.middle",
		agente: "band.agent",
		"sin evidencia": "band.noEvidence"
	};

	type ProfileId = "naive" | "humanized" | "replay";
	type Band = "humano" | "zona media" | "agente" | "sin evidencia";

	interface Result {
		id: ProfileId;
		samples: PointerSample[];
		score: number | null;
		band: Band;
		detected: boolean;
		reason: string;
	}

	interface SyntheticEvent {
		clientX: number;
		clientY: number;
		timeStamp: number;
		pointerType: string;
		isTrusted: boolean;
	}

	interface SyntheticTarget {
		addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void;
		removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void;
		emit(type: string, event: SyntheticEvent): void;
	}

	const PROFILES: Array<{
		id: ProfileId;
		nameKey: DemoTranslationKey;
		detailKey: DemoTranslationKey;
		limitationKey: DemoTranslationKey;
	}> = [
		{
			id: "naive",
			nameKey: "profile.naive.name",
			detailKey: "lab.profile.naive.detail",
			limitationKey: "lab.profile.naive.limitation"
		},
		{
			id: "humanized",
			nameKey: "profile.humanized.name",
			detailKey: "profile.humanized.detail",
			limitationKey: "lab.profile.humanized.limitation"
		},
		{
			id: "replay",
			nameKey: "profile.replay.name",
			detailKey: "lab.profile.replay.detail",
			limitationKey: "lab.profile.replay.limitation"
		}
	];

	// Generador determinista: mismo perfil, mismas muestras en cada ejecución.
	function random(seed: number): () => number {
		let a = seed >>> 0;
		return () => {
			a = (1664525 * a + 1013904223) >>> 0;
			return a / 4294967296;
		};
	}

	function makeWriter(): (points: PointerSample[], x: number, y: number, dt: number) => void {
		let seq = 0;
		let t = 0;
		return (points, x, y, dt) => {
			t += dt;
			points.push({ seq: ++seq, x, y, t, kind: 0, pointerType: 0, trusted: 0 });
		};
	}

	function naiveBot(): PointerSample[] {
		const points: PointerSample[] = [];
		const push = makeWriter();
		let x = 94;
		push(points, x, 180, 0);
		for (let block = 0; block < 5; block += 1) {
			for (let i = 0; i < 6; i += 1) {
				x += 11;
				push(points, x, 180, 16);
			}
			if (block < 4) {
				x += 150;
				push(points, x, 180, 16);
			}
		}
		return points;
	}

	function humanLike(
		seed: number,
		options: { jitter: number; pauseEvery: number; pauseMs: number; overshoot?: boolean }
	): PointerSample[] {
		const points: PointerSample[] = [];
		const push = makeWriter();
		const rnd = random(seed);
		for (let i = 0; i < 48; i += 1) {
			const phase = i / 47;
			const x = 94 + 616 * phase + (rnd() - 0.5) * options.jitter;
			const y = 300 + 55 * Math.sin(phase * Math.PI * 2) + (rnd() - 0.5) * options.jitter;
			const dt = 18 + rnd() * 45 + (i > 0 && i % options.pauseEvery === 0 ? options.pauseMs : 0);
			push(points, x, y, i === 0 ? 0 : dt);
		}
		if (options.overshoot) {
			push(points, 716, 296 + (rnd() - 0.5) * 8, 60);
			push(points, 706, 302 + (rnd() - 0.5) * 8, 90);
			push(points, 720, 300 + (rnd() - 0.5) * 8, 110);
		}
		return points;
	}

	// Trazo humano fijo de referencia, reemplazable por una captura en memoria.
	let replayPoints = $state<PointerSample[]>(
		humanLike(7, { jitter: 9, pauseEvery: 9, pauseMs: 220, overshoot: true })
	);
	let replayIsMine = $state(false);
	type CaptureNote = { key: DemoTranslationKey; params?: TranslationParams };
	let captureNoteState = $state<CaptureNote | null>(null);
	let captureNote = $derived(
		captureNoteState === null ? "" : tr(captureNoteState.key, captureNoteState.params)
	);

	// Target artificial: captura los listeners del colector y les entrega eventos
	// con marcas de tiempo controladas. No se toca el detector en vivo.
	function syntheticTarget(): SyntheticTarget {
		const listeners = new Map<string, (event: Event) => void>();
		return {
			addEventListener(type, listener) {
				if (typeof listener === "function") listeners.set(type, listener);
			},
			removeEventListener(type) {
				listeners.delete(type);
			},
			emit(type, event) {
				listeners.get(type)?.(event as unknown as Event);
			}
		};
	}

	function bandOf(score: number | null): Band {
		if (score === null) return "sin evidencia";
		if (score <= HUMAN_MAX) return "humano";
		if (score >= AI_MIN) return "agente";
		return "zona media";
	}

	function measure(profile: (typeof PROFILES)[number], points: PointerSample[]): Result {
		const target = syntheticTarget();
		const clock = { t: 0 };
		const collector = createMouseCollector({
			target: target as unknown as EventTarget,
			now: () => clock.t,
			bufferSize: 1024
		});
		collector.attach();
		for (const p of points) {
			clock.t = p.t;
			target.emit("pointermove", {
				clientX: p.x,
				clientY: p.y,
				timeStamp: p.t,
				pointerType: "mouse",
				isTrusted: false
			});
		}
		collector.detach();

		const samples = collector.getSamples();
		const windowMs = samples.length >= 2 ? samples[samples.length - 1].t - samples[0].t : 0;
		// Una evaluación limpia: sin el suavizado EMA del detector en vivo.
		const evidence = new ScoreComputer().evaluate(samples, windowMs);
		return {
			id: profile.id,
			samples,
			score: evidence.score,
			band: bandOf(evidence.score),
			detected: bandOf(evidence.score) === "agente",
			reason: evidence.reasons[0] ?? tr("noReasons")
		};
	}

	function runAll(): void {
		results = PROFILES.map((profile) =>
			measure(profile, profile.id === "replay" ? replayPoints : generators[profile.id]())
		);
	}

	const generators: Record<"naive" | "humanized", () => PointerSample[]> = {
		naive: naiveBot,
		humanized: () => humanLike(42, { jitter: 6, pauseEvery: 13, pauseMs: 180 })
	};

	function captureLive(): void {
		const captured = live.points.filter((p) => p.kind === 0);
		const span = captured.length >= 2 ? captured[captured.length - 1].t - captured[0].t : 0;
		if (captured.length < 12 || span < 400) {
			captureNoteState = { key: "lab.capture.short" };
			return;
		}
		replayPoints = captured;
		replayIsMine = true;
		captureNoteState = { key: "lab.capture.done", params: { count: captured.length } };
		runAll();
	}

	// ---- Traza mostrada: en vivo (sondeo compartido) o perfil seleccionado ---
	let points = $derived(live.points);
	let verdict = $derived(live.verdict);
	let results = $state<Result[]>([]);
	let mode = $state<"live" | "sim">("live");
	let selected = $state<ProfileId>("naive");

	const selectedResult = $derived(results.find((r) => r.id === selected) ?? null);
	const shownPoints = $derived(mode === "sim" ? (selectedResult?.samples ?? []) : points);

	const VIEW_W = 100;
	const VIEW_H = 62;
	const PAD = 6;

	function frameOf(samples: PointerSample[]) {
		if (samples.length === 0) return null;
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const p of samples) {
			minX = Math.min(minX, p.x);
			minY = Math.min(minY, p.y);
			maxX = Math.max(maxX, p.x);
			maxY = Math.max(maxY, p.y);
		}
		const spanX = maxX - minX;
		const spanY = maxY - minY;
		const scale = Math.max(spanX / (VIEW_W - PAD * 2), spanY / (VIEW_H - PAD * 2));
		const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
		const ox = (VIEW_W - spanX * safeScale) / 2 - minX * safeScale;
		const oy = (VIEW_H - spanY * safeScale) / 2 - minY * safeScale;
		const project = (p: PointerSample) => ({
			x: p.x * safeScale + ox,
			y: p.y * safeScale + oy
		});
		return {
			start: project(samples[0]),
			end: project(samples[samples.length - 1]),
			path: samples.map((p) => {
				const q = project(p);
				return `${q.x.toFixed(2)},${q.y.toFixed(2)}`;
			})
		};
	}

	const frame = $derived(frameOf(shownPoints));
	const spanLabel = $derived.by(() => {
		if (shownPoints.length < 2) return "—";
		return `${((shownPoints[shownPoints.length - 1].t - shownPoints[0].t) / 1000).toFixed(1)} s`;
	});

	const liveState = $derived(
		verdict.state === "ai"
			? tr("label.ai")
			: verdict.state === "human"
				? tr("label.human")
				: tr("label.measuring")
	);
	const sourceLabel = $derived(
		mode === "live"
			? tr("pathview.source.live")
			: tr("lab.source.sim", {
					name: PROFILES.find((p) => p.id === selected)?.nameKey
						? tr(PROFILES.find((p) => p.id === selected)!.nameKey)
						: ""
				})
	);
	const currentVerdict = $derived(mode === "live" ? liveState : (selectedResult?.band ?? "—"));

	onMount(() => {
		runAll();
	});
</script>

<section class="section lab-section" aria-labelledby="lab-title">
	<div class="lab-content">
		<h2 id="lab-title" class="section-title">{tr("lab.title")}</h2>
		<p class="section-body">{tr("lab.body")}</p>

		<div class="lab-grid">
			<div class="lab-card">
				<div class="lab-card-head">
					<div class="lab-source">
						<span class="lab-dot" class:lab-dot--sim={mode === "sim"}></span>
						<span>{sourceLabel}</span>
					</div>
					<p class="lab-meta">{tr("lab.meta", { count: shownPoints.length, span: spanLabel, verdict: currentVerdict })}</p>
				</div>

				<div class="lab-toggle" role="group" aria-label={tr("lab.group.trace.aria")}>
					<button
						type="button"
						class="lab-chip"
						class:is-active={mode === "live"}
						aria-pressed={mode === "live"}
						onclick={() => (mode = "live")}>{tr("lab.button.live")}</button
					>
					<button
						type="button"
						class="lab-chip"
						class:is-active={mode === "sim"}
						aria-pressed={mode === "sim"}
						onclick={() => (mode = "sim")}>{tr("lab.button.sim")}</button
					>
				</div>

				<div class="lab-canvas">
					<svg
						viewBox="0 0 {VIEW_W} {VIEW_H}"
						role="img"
						aria-label={tr("lab.svg.aria", { source: sourceLabel, count: shownPoints.length, verdict: currentVerdict })}
						preserveAspectRatio="xMidYMid meet"
					>
						<defs>
							<pattern
								id="lab-grid-pattern"
								class="lab-grid-pattern"
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
							fill="url(#lab-grid-pattern)"
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
								class="lab-path"
								aria-hidden="true"
							/>
							<circle cx={frame.start.x} cy={frame.start.y} r="1.5" class="lab-start" aria-hidden="true" />
							<circle cx={frame.end.x} cy={frame.end.y} r="1.5" class="lab-end" aria-hidden="true" />
						{/if}
					</svg>
					{#if !frame}
						<p class="lab-empty">{tr("lab.empty")}</p>
					{/if}
				</div>

				<div class="lab-legend">
					<span><i class="lab-key lab-key--start" aria-hidden="true"></i>{tr("legend.start")}</span>
					<span><i class="lab-key lab-key--end" aria-hidden="true"></i>{tr("legend.end")}</span>
					<span class="lab-legend-note">{tr("legend.scale")}</span>
				</div>
			</div>

			<div class="lab-card lab-card--controls">
				<h3 class="lab-card-title">{tr("lab.profiles.title")}</h3>
				<div class="lab-profiles" role="group" aria-label={tr("lab.group.profile.aria")}>
					{#each PROFILES as profile (profile.id)}
						<button
							type="button"
							class="lab-profile"
							class:is-active={selected === profile.id}
							aria-pressed={selected === profile.id}
							onclick={() => {
								selected = profile.id;
								mode = "sim";
							}}
						>
							<span class="lab-profile-name">{tr(profile.nameKey)}</span>
							<span class="lab-profile-detail">{tr(profile.detailKey)}</span>
						</button>
					{/each}
				</div>
				<div class="lab-actions">
					<button type="button" class="lab-button" onclick={captureLive}>{tr("lab.button.capture")}</button>
					<button type="button" class="lab-button lab-button--quiet" onclick={runAll}>
						{tr("lab.button.repeat")}
					</button>
				</div>
				<p class="lab-note" aria-live="polite">{captureNote || tr("lab.note.capture")}</p>
				<p class="lab-note">
					{replayIsMine ? tr("lab.note.replayMine") : tr("lab.note.replayFixed")}
					{tr("lab.note.profiles")}
				</p>
			</div>
		</div>

		<div class="lab-card lab-card--table">
			<div class="lab-card-head">
				<h3 class="lab-card-title">{tr("lab.results.title")} <span class="lab-tag">{tr("simulated")}</span></h3>
				<p class="lab-meta">{tr("breakdown.scale")}</p>
			</div>
			<div class="lab-scroll">
				<table>
					<caption class="lab-sr-only">{tr("lab.caption")}</caption>
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
									<span class="lab-row-name">{profile ? tr(profile.nameKey) : result.id}</span>
									<span class="lab-row-meta"
										>{tr("simulated")} · {tr("lab.row.meta", { count: result.samples.length })}</span
									>
								</th>
								<td>
									<span class="lab-score">{result.score === null ? "—" : result.score.toFixed(2)}</span>
									<span class="lab-row-meta">{result.reason}</span>
								</td>
								<td class="lab-band" class:lab-band--agent={result.band === "agente"}>
									{tr(BAND_KEY[result.band])}
								</td>
								<td>{result.detected ? tr("yes") : tr("no")}</td>
								<td class="lab-limitation">
									{result.id === "replay" && replayIsMine
										? tr("lab.limitation.mine")
										: (profile ? tr(profile.limitationKey) : "")}
								</td>
							</tr>
						{/each}
						{#if results.length === 0}
							<tr>
								<td colspan="5" class="lab-limitation">{tr("lab.note.empty")}</td>
							</tr>
						{/if}
					</tbody>
				</table>
			</div>
		</div>

		<p class="lab-footnote">{tr("lab.footnote")}</p>
	</div>
</section>

<style>
	.lab-section {
		gap: 1rem;
	}

	.lab-content {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.9rem;
		width: min(60rem, 100%);
	}

	.lab-grid {
		display: grid;
		grid-template-columns: minmax(0, 1.4fr) minmax(15rem, 0.6fr);
		gap: 0.75rem;
		width: 100%;
	}

	.lab-card {
		min-width: 0;
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		padding: 0.85rem 0.95rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--card) 94%, var(--muted));
	}

	.lab-card-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.4rem 0.75rem;
	}

	.lab-source {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		font-size: 0.75rem;
		font-weight: 600;
	}

	.lab-dot {
		width: 0.45rem;
		height: 0.45rem;
		border-radius: 9999px;
		background: var(--color-verdict-humano);
	}

	.lab-dot--sim {
		background: var(--color-verdict-midiendo);
	}

	.lab-card-title {
		margin: 0;
		font-size: 0.8125rem;
		font-weight: 600;
	}

	.lab-meta,
	.lab-note,
	.lab-legend,
	.lab-footnote {
		margin: 0;
		font-size: 0.6875rem;
		color: var(--muted-foreground);
	}

	.lab-toggle {
		display: inline-flex;
		gap: 0.25rem;
	}

	.lab-chip,
	.lab-button {
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

	.lab-chip:hover,
	.lab-button:hover {
		background: var(--accent);
	}

	.lab-chip.is-active {
		background: var(--foreground);
		color: var(--background);
	}

	.lab-canvas {
		position: relative;
		width: 100%;
	}

	.lab-canvas svg {
		display: block;
		width: 100%;
		height: auto;
		aspect-ratio: 100 / 62;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--muted) 40%, var(--card));
	}

	.lab-grid-pattern {
		color: var(--border);
	}

	.lab-path {
		color: color-mix(in srgb, var(--foreground) 80%, transparent);
	}

	.lab-start {
		fill: var(--color-verdict-humano);
	}

	.lab-end {
		fill: var(--color-verdict-ia);
	}

	.lab-empty {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		font-size: 0.75rem;
		color: var(--muted-foreground);
		pointer-events: none;
	}

	.lab-legend {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.9rem;
	}

	.lab-legend span {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
	}

	.lab-key {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 9999px;
	}

	.lab-key--start {
		background: var(--color-verdict-humano);
	}

	.lab-key--end {
		background: var(--color-verdict-ia);
	}

	.lab-legend-note {
		margin-left: auto;
		opacity: 0.8;
	}

	.lab-profiles {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.lab-profile {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		text-align: left;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--card);
		color: var(--foreground);
		padding: 0.4rem 0.55rem;
		font: inherit;
		cursor: pointer;
		transition: background-color var(--dur-180), border-color var(--dur-180);
	}

	.lab-profile:hover {
		background: var(--accent);
	}

	.lab-profile.is-active {
		border-color: var(--foreground);
		background: var(--accent);
	}

	.lab-profile-name {
		font-size: 0.75rem;
		font-weight: 600;
	}

	.lab-profile-detail {
		font-size: 0.6875rem;
		color: var(--muted-foreground);
	}

	.lab-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		margin-top: auto;
	}

	.lab-button--quiet {
		background: transparent;
	}

	.lab-note {
		line-height: 1.5;
	}

	.lab-card--table {
		gap: 0.5rem;
	}

	.lab-tag {
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

	.lab-scroll {
		width: 100%;
		overflow-x: auto;
	}

	table {
		width: 100%;
		min-width: 40rem;
		border-collapse: collapse;
		font-size: 0.75rem;
	}

	caption {
		text-align: left;
	}

	th,
	td {
		padding: 0.45rem 0.55rem;
		border-bottom: 1px solid var(--border);
		text-align: left;
		vertical-align: top;
	}

	thead th {
		font-size: 0.625rem;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--muted-foreground);
	}

	tbody th {
		font-weight: 400;
	}

	tbody tr:last-child th,
	tbody tr:last-child td {
		border-bottom: 0;
	}

	.lab-row-name,
	.lab-score {
		display: block;
		font-variant-numeric: tabular-nums;
	}

	.lab-row-name {
		font-weight: 600;
	}

	.lab-score {
		font-size: 0.875rem;
		font-weight: 600;
	}

	.lab-row-meta {
		display: block;
		margin-top: 0.1rem;
		font-size: 0.625rem;
		font-weight: 400;
		color: var(--muted-foreground);
	}

	.lab-band {
		white-space: nowrap;
		color: color-mix(in srgb, var(--color-verdict-humano) 72%, var(--foreground));
	}

	.lab-band--agent {
		color: color-mix(in srgb, var(--color-verdict-ia) 72%, var(--foreground));
	}

	.lab-limitation {
		color: var(--muted-foreground);
		line-height: 1.45;
	}

	.lab-footnote {
		width: 100%;
		line-height: 1.5;
	}

	.lab-sr-only {
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

	@media (max-width: 900px) {
		.lab-grid {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.lab-chip,
		.lab-button,
		.lab-profile {
			transition: none;
		}
	}
</style>
