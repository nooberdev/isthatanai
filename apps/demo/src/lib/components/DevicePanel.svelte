<script lang="ts">
	// Perfiles de dispositivo: mismas muestras sintéticas para los cuatro perfiles.
	// El colector de teclado trabaja sobre un target artificial y el score se
	// calcula a mano con ScoreComputer. Nada se envía ni se guarda.

	import { onMount } from "svelte";
	import {
		AI_MIN,
		HUMAN_MAX,
		IsThatAnAI,
		ScoreComputer,
		createKeyboardCollector,
		inferDeviceProfile,
		type DeviceProfile
	} from "is-that-an-ai";
	import { tr, type DemoTranslationKey } from "#lib/i18n";

	const BAND_KEY: Record<Band, DemoTranslationKey> = {
		humano: "band.human",
		"zona media": "band.middle",
		agente: "band.agent",
		"sin evidencia": "band.noEvidence"
	};

	let {
		getDeviceProfile
	}: {
		getDeviceProfile?: () => DeviceProfile | null;
	} = $props();

	type Band = "humano" | "zona media" | "agente" | "sin evidencia";
	type Sequence = "mando" | "bot";

	interface SyntheticKeyEvent {
		type: "keydown" | "keyup";
		code: string;
		timeStamp: number;
		isTrusted: boolean;
	}

	interface SyntheticTarget {
		addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void;
		removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void;
		emit(type: string, event: SyntheticKeyEvent): void;
	}

	interface Result {
		id: DeviceProfile;
		sequence: Sequence;
		reported: DeviceProfile;
		resolved: DeviceProfile;
		score: number | null;
		band: Band;
		detected: boolean;
		reason: string;
	}

	const PROFILES: Array<{ id: DeviceProfile; nameKey: DemoTranslationKey; detailKey: DemoTranslationKey }> = [
		{ id: "auto", nameKey: "device.profile.auto.name", detailKey: "device.profile.auto.detail" },
		{ id: "desktop", nameKey: "device.profile.desktop.name", detailKey: "device.profile.desktop.detail" },
		{ id: "touch", nameKey: "device.profile.touch.name", detailKey: "device.profile.touch.detail" },
		{ id: "tv", nameKey: "device.profile.tv.name", detailKey: "device.profile.tv.detail" }
	];

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

	// Generadores deterministas: misma secuencia en cada medición.
	function random(seed: number): () => number {
		let a = seed >>> 0;
		return () => {
			a = (1664525 * a + 1013904223) >>> 0;
			return a / 4294967296;
		};
	}

	function remoteEvents(): SyntheticKeyEvent[] {
		const rnd = random(20261126);
		const codes = ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Enter", "Escape"];
		// Tres cadencias entre 300 y 900 ms, con pausas largas cada ocho pulsaciones.
		const delays = [430, 600, 780];
		const events: SyntheticKeyEvent[] = [];
		let t = 0;
		for (let i = 0; i < 24; i += 1) {
			if (i > 0) t += delays[i % delays.length] + (i % 8 === 0 ? 1200 : 0);
			const code = codes[i % codes.length];
			events.push({ type: "keydown", code, timeStamp: t, isTrusted: false });
			events.push({ type: "keyup", code, timeStamp: t + 40 + rnd() * 260, isTrusted: false });
		}
		return events;
	}

	function botEvents(): SyntheticKeyEvent[] {
		const events: SyntheticKeyEvent[] = [];
		for (let i = 0; i < 24; i += 1) {
			const t = i * 60;
			events.push({ type: "keydown", code: "ArrowRight", timeStamp: t, isTrusted: false });
			events.push({ type: "keyup", code: "ArrowRight", timeStamp: t + 10, isTrusted: false });
		}
		return events;
	}

	function bandOf(score: number | null): Band {
		if (score === null) return "sin evidencia";
		if (score <= HUMAN_MAX) return "humano";
		if (score >= AI_MIN) return "agente";
		return "zona media";
	}

	function measure(id: DeviceProfile, sequence: Sequence, events: SyntheticKeyEvent[]): Result {
		const target = syntheticTarget();
		const clock = { t: 0 };
		const collector = createKeyboardCollector({
			target: target as unknown as EventTarget,
			now: () => clock.t,
			bufferSize: 256
		});
		collector.attach();
		for (const event of events) {
			clock.t = event.timeStamp;
			target.emit(event.type, event);
		}
		collector.detach();

		const keys = collector.getSamples();
		// Instancia nueva por perfil y secuencia; sin start(): no toca el DOM.
		const detector = new IsThatAnAI({ device: id, now: () => clock.t });
		// Auto se resuelve con la misma función que usa el detector internamente.
		const resolved = id === "auto" ? inferDeviceProfile([], keys, []) : id;
		const evidence = new ScoreComputer().evaluate([], 0, [], [], keys, [], resolved);
		const band = bandOf(evidence.score);
		return {
			id,
			sequence,
			reported: detector.getDeviceProfile(),
			resolved,
			score: evidence.score,
			band,
			detected: band === "agente",
			reason: evidence.reasons[0] ?? tr("noReasons")
		};
	}

	let selected = $state<DeviceProfile>("auto");
	let results = $state<Result[]>([]);

	function runAll(): void {
		const remote = remoteEvents();
		const bot = botEvents();
		results = PROFILES.flatMap((profile) => [
			measure(profile.id, "mando", remote),
			measure(profile.id, "bot", bot)
		]);
	}

	function selectProfile(id: DeviceProfile): void {
		selected = id;
		runAll();
	}

	const liveProfile = $derived(getDeviceProfile?.() ?? null);
	const botDetected = $derived(results.some((r) => r.sequence === "bot" && r.detected));
	const remoteDetected = $derived(results.some((r) => r.sequence === "mando" && r.detected));
	const showLimitation = $derived(results.length > 0 && botDetected && !remoteDetected);
	const selectedName = $derived(tr(PROFILES.find((p) => p.id === selected)?.nameKey ?? "device.profile.auto.name"));

	onMount(runAll);
</script>

<section class="section tv-section" aria-labelledby="tv-title">
	<div class="tv-content">
		<h2 id="tv-title" class="section-title">{tr("device.title")}</h2>
		<p class="section-body">
			{tr("device.body1")}<br />
			{tr("device.body2")}
		</p>
		<p class="tv-live">{tr("device.live.prefix")} <strong>{liveProfile ?? "—"}</strong></p>

		<div class="tv-card">
			<div class="tv-card-head">
				<h3 class="tv-card-title">{tr("device.force.title")}</h3>
				<p class="tv-meta">{tr("device.force.meta")}</p>
			</div>
			<div class="tv-profiles" role="group" aria-label={tr("device.group.aria")}>
				{#each PROFILES as profile (profile.id)}
					<button
						type="button"
						class="tv-chip"
						class:is-active={selected === profile.id}
						aria-pressed={selected === profile.id}
						onclick={() => selectProfile(profile.id)}
					>
						<span class="tv-chip-name">{tr(profile.nameKey)}</span>
						<span class="tv-chip-detail">{tr(profile.detailKey)}</span>
					</button>
				{/each}
			</div>
			<div class="tv-actions">
				<button type="button" class="tv-button" onclick={runAll}>{tr("device.button.repeat")}</button>
				<span class="tv-note">{tr("device.note.active", { name: selectedName })}</span>
			</div>
		</div>

		<div class="tv-card tv-card--table">
			<div class="tv-card-head">
				<h3 class="tv-card-title">
					{tr("device.results.title")} <span class="tv-tag">{tr("simulated")}</span>
				</h3>
				<p class="tv-meta">{tr("breakdown.scale")}</p>
			</div>
			<div class="tv-scroll">
				<table>
					<caption class="tv-sr-only">
						{tr("device.caption")}
					</caption>
					<thead>
						<tr>
							<th scope="col">{tr("table.th.profile")}</th>
							<th scope="col">{tr("device.th.getter")}</th>
							<th scope="col">{tr("table.th.score")}</th>
							<th scope="col">{tr("table.th.verdict")}</th>
							<th scope="col">{tr("table.th.detected")}</th>
						</tr>
					</thead>
					<tbody>
						{#each results as result (result.id + result.sequence)}
							<tr class:is-selected={result.id === selected}>
								<th scope="row">
									<span class="tv-row-name">{tr(PROFILES.find((p) => p.id === result.id)?.nameKey ?? "device.profile.auto.name")}</span>
									<span class="tv-row-meta"
										>{tr("simulated")} · {result.sequence === "mando" ? tr("device.row.remote") : tr("device.row.bot")}</span
									>
								</th>
								<td>
									<span class="tv-profile-value">{result.reported}</span>
									{#if result.id === "auto"}
										<span class="tv-row-meta">{tr("device.row.resolved", { profile: result.resolved })}</span>
									{/if}
								</td>
								<td>
									<span class="tv-score">{result.score === null ? "—" : result.score.toFixed(2)}</span>
									<span class="tv-row-meta">{result.reason}</span>
								</td>
								<td class="tv-band" class:tv-band--agent={result.band === "agente"}>
									{tr(BAND_KEY[result.band])}
								</td>
								<td>{result.detected ? tr("yes") : tr("no")}</td>
							</tr>
						{/each}
						{#if results.length === 0}
							<tr>
								<td colspan="5" class="tv-limitation">{tr("preparing")}</td>
							</tr>
						{/if}
						{#if showLimitation}
							<tr class="tv-limit-row">
								<td colspan="5" class="tv-limitation">
									{tr("device.limitation")}
								</td>
							</tr>
						{/if}
					</tbody>
				</table>
			</div>
		</div>

		<p class="tv-footnote">{tr("device.footnote")}</p>
	</div>
</section>

<style>
	.tv-section {
		gap: 1rem;
	}

	.tv-content {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.9rem;
		width: min(60rem, 100%);
	}

	.tv-live {
		align-self: flex-start;
		margin: 0;
		font-size: 0.6875rem;
		color: var(--muted-foreground);
	}

	.tv-live strong {
		color: var(--foreground);
		font-weight: 600;
	}

	.tv-card {
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		width: 100%;
		min-width: 0;
		padding: 0.85rem 0.95rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--card) 94%, var(--muted));
	}

	.tv-card-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.4rem 0.75rem;
	}

	.tv-card-title {
		margin: 0;
		font-size: 0.8125rem;
		font-weight: 600;
	}

	.tv-meta,
	.tv-note,
	.tv-footnote {
		margin: 0;
		font-size: 0.6875rem;
		color: var(--muted-foreground);
	}

	.tv-profiles {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 0.35rem;
	}

	.tv-chip {
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

	.tv-chip:hover {
		background: var(--accent);
	}

	.tv-chip.is-active {
		border-color: var(--foreground);
		background: var(--accent);
	}

	.tv-chip-name {
		font-size: 0.75rem;
		font-weight: 600;
	}

	.tv-chip-detail {
		font-size: 0.625rem;
		color: var(--muted-foreground);
	}

	.tv-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem;
	}

	.tv-button {
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

	.tv-button:hover {
		background: var(--accent);
	}

	.tv-card--table {
		gap: 0.5rem;
	}

	.tv-tag {
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

	.tv-scroll {
		width: 100%;
		overflow-x: auto;
	}

	table {
		width: 100%;
		min-width: 44rem;
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

	tbody tr.is-selected > * {
		background: color-mix(in srgb, var(--accent) 60%, transparent);
	}

	tbody tr:not(.tv-limit-row):last-child th,
	tbody tr:not(.tv-limit-row):last-child td {
		border-bottom: 0;
	}

	.tv-row-name,
	.tv-profile-value,
	.tv-score {
		display: block;
		font-variant-numeric: tabular-nums;
	}

	.tv-row-name {
		font-weight: 600;
	}

	.tv-profile-value {
		text-transform: capitalize;
	}

	.tv-score {
		font-size: 0.875rem;
		font-weight: 600;
	}

	.tv-row-meta {
		display: block;
		margin-top: 0.1rem;
		font-size: 0.625rem;
		font-weight: 400;
		color: var(--muted-foreground);
	}

	.tv-band {
		white-space: nowrap;
		color: color-mix(in srgb, var(--color-verdict-humano) 72%, var(--foreground));
	}

	.tv-band--agent {
		color: color-mix(in srgb, var(--color-verdict-ia) 72%, var(--foreground));
	}

	.tv-limit-row td {
		border-top: 1px solid color-mix(in srgb, var(--foreground) 20%, transparent);
	}

	.tv-limitation {
		color: var(--muted-foreground);
		line-height: 1.45;
	}

	.tv-footnote {
		width: 100%;
		line-height: 1.5;
	}

	.tv-sr-only {
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
		.tv-profiles {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.tv-chip,
		.tv-button {
			transition: none;
		}
	}
</style>
