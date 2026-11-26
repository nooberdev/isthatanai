<script lang="ts">
	import { LOCALES, type IsThatAnAI } from "is-that-an-ai";
	import {
		i18n,
		languageName,
		tr,
		type DemoTranslationKey,
		type LanguageChoice
	} from "#lib/i18n";
	import { live, type DetailedDevice } from "#lib/detector/live.svelte";

	// Contrato de la Etapa 9. La librería ya publica los getters; se comprueba
	// su presencia en tiempo de ejecución para seguir funcionando con builds
	// anteriores. El dispositivo detallado llega vía `live`, que sondea el getter real.
	type Sensitivity = "estricto" | "normal" | "relajado";
	type Stage9Config = {
		sensitivity?: Sensitivity;
		accessibility?: boolean;
		advancedMeasures?: boolean;
	};
	type Stage9Detector = IsThatAnAI & {
		getSensitivity?(): Sensitivity;
		getAccessibility?(): boolean | "auto";
		getAdvancedMeasures?(): boolean;
	};

	const SENSITIVITIES: readonly Sensitivity[] = ["estricto", "normal", "relajado"];
	const SENSITIVITY_KEY: Record<Sensitivity, DemoTranslationKey> = {
		estricto: "settings.sensitivity.estricto",
		normal: "settings.sensitivity.normal",
		relajado: "settings.sensitivity.relajado"
	};
	const DEVICE_KEY: Record<DetailedDevice, DemoTranslationKey> = {
		computadora: "settings.device.computadora",
		laptop: "settings.device.laptop",
		celular: "settings.device.celular",
		tablet: "settings.device.tablet",
		tv: "settings.device.tv",
		touch: "settings.device.touch"
	};

	let { detector = null }: { detector?: IsThatAnAI | null } = $props();

	let selection = $state<LanguageChoice>(i18n.mode);
	let sensitivity = $state<Sensitivity>("normal");
	let accessibility = $state(false);
	// Opt-in: la calibración validada permanece intacta cuando está apagado.
	let advancedMeasures = $state(false);

	// El selector refleja siempre el idioma activo, también si cambia desde otro lado.
	$effect(() => {
		selection = i18n.mode;
	});

	// Los valores activos salen del detector cuando el getter ya está disponible.
	$effect(() => {
		const d = detector as Stage9Detector | null;
		if (!d) return;
		const currentSensitivity = d.getSensitivity?.();
		if (currentSensitivity !== undefined) sensitivity = currentSensitivity;
		const currentAccessibility = d.getAccessibility?.();
		if (typeof currentAccessibility === "boolean") accessibility = currentAccessibility;
		const currentAdvanced = d.getAdvancedMeasures?.();
		if (typeof currentAdvanced === "boolean") advancedMeasures = currentAdvanced;
	});

	function configureStage9(next: Stage9Config): void {
		const d = detector as Stage9Detector | null;
		if (!d) return;
		(d.configure as (config: Stage9Config) => void)(next);
	}

	function onChange(): void {
		i18n.select(selection);
	}

	function onSensitivityChange(): void {
		configureStage9({ sensitivity });
		const current = (detector as Stage9Detector | null)?.getSensitivity?.();
		if (current !== undefined) sensitivity = current;
	}

	function onAccessibilityChange(): void {
		configureStage9({ accessibility });
		const current = (detector as Stage9Detector | null)?.getAccessibility?.();
		if (typeof current === "boolean") accessibility = current;
	}

	function onAdvancedChange(): void {
		configureStage9({ advancedMeasures });
		const current = (detector as Stage9Detector | null)?.getAdvancedMeasures?.();
		if (typeof current === "boolean") advancedMeasures = current;
		// El modo de privacidad puede cambiar: el sondeo compartido lo refleja ya.
		live.pump();
	}

	// La lectura detallada viene del único sondeo compartido (live), sin intervalo nuevo.
	let detailedDevice = $derived(live.detailedDevice);
	let sensitivityText = $derived(tr(SENSITIVITY_KEY[sensitivity]));
	let accessibilityText = $derived(
		tr(accessibility ? "settings.accessibility.on" : "settings.accessibility.off")
	);
	let advancedText = $derived(
		tr(advancedMeasures ? "settings.advanced.on" : "settings.advanced.off")
	);
	let deviceText = $derived(
		detailedDevice === null ? "—" : tr(DEVICE_KEY[detailedDevice])
	);
</script>

<section class="section">
	<h2 class="section-title">{tr("section.settings.title")}</h2>
	<p class="section-body">{tr("section.settings.body")}</p>

	<div class="settings-controls">
		<div class="setting">
			<div class="setting__text">
				<label class="setting__label" for="settings-language-select">
					{tr("settings.language.label")}
				</label>
				<p id="settings-language-hint" class="setting__hint">
					{tr("settings.language.hint")}
				</p>
			</div>
			<div class="setting__control">
				<div class="select-wrap">
					<select
						id="settings-language-select"
						class="select"
						bind:value={selection}
						onchange={onChange}
						aria-describedby="settings-language-hint"
					>
						<option value="auto">{tr("settings.language.auto")}</option>
						{#each LOCALES as locale (locale)}
							<option value={locale}>{languageName(locale)}</option>
						{/each}
					</select>
					<span class="select-arrow material-symbols-rounded" aria-hidden="true">expand_more</span>
				</div>
			</div>
		</div>

		<div class="setting">
			<div class="setting__text">
				<label class="setting__label" for="settings-sensitivity-select">
					{tr("settings.sensitivity.label")}
				</label>
				<p id="settings-sensitivity-active" class="setting__state">
					{tr("settings.sensitivity.active", { value: sensitivityText })}
				</p>
				<p id="settings-sensitivity-hint" class="setting__hint">
					{tr("settings.sensitivity.hint")}
				</p>
			</div>
			<div class="setting__control">
				<div class="select-wrap">
					<select
						id="settings-sensitivity-select"
						class="select"
						bind:value={sensitivity}
						onchange={onSensitivityChange}
						aria-describedby="settings-sensitivity-active settings-sensitivity-hint"
					>
						{#each SENSITIVITIES as value (value)}
							<option {value}>{tr(SENSITIVITY_KEY[value])}</option>
						{/each}
					</select>
					<span class="select-arrow material-symbols-rounded" aria-hidden="true">expand_more</span>
				</div>
			</div>
		</div>

		<div class="setting">
			<div class="setting__text">
				<label class="setting__label" for="settings-accessibility-toggle">
					{tr("settings.accessibility.label")}
				</label>
				<p id="settings-accessibility-hint" class="setting__hint">
					{tr("settings.accessibility.hint")}
				</p>
			</div>
			<div class="setting__control switch-row">
				<input
					id="settings-accessibility-toggle"
					class="switch"
					type="checkbox"
					role="switch"
					bind:checked={accessibility}
					onchange={onAccessibilityChange}
					aria-describedby="settings-accessibility-hint"
				/>
				<span class="switch-state">{accessibilityText}</span>
			</div>
		</div>

		<div class="setting">
			<div class="setting__text">
				<label class="setting__label" for="settings-advanced-toggle">
					{tr("settings.advanced.label")}
				</label>
				<p id="settings-advanced-hint" class="setting__hint">
					{tr("settings.advanced.hint")}
				</p>
			</div>
			<div class="setting__control switch-row">
				<input
					id="settings-advanced-toggle"
					class="switch"
					type="checkbox"
					role="switch"
					bind:checked={advancedMeasures}
					onchange={onAdvancedChange}
					aria-describedby="settings-advanced-hint"
				/>
				<span class="switch-state">{advancedText}</span>
			</div>
		</div>

		<div class="setting" role="group" aria-labelledby="settings-device-label">
			<div class="setting__text">
				<span id="settings-device-label" class="setting__label">
					{tr("settings.device.label")}
				</span>
				<p id="settings-device-hint" class="setting__hint">
					{tr("settings.device.hint")}
				</p>
			</div>
			<div class="setting__control">
				<output
					id="settings-device-value"
					class="device-status"
					class:is-empty={detailedDevice === null}
					aria-describedby="settings-device-hint"
					aria-live="polite"
				>
					<span class="device-status__dot" aria-hidden="true"></span>
					<span class="device-status__value">{deviceText}</span>
				</output>
			</div>
		</div>
	</div>
</section>

<style>
	.settings-controls {
		box-sizing: border-box;
		display: grid;
		width: min(46rem, 100%);
		margin-top: 1.5rem;
		border-top: 1px solid var(--border);
	}

	/* Fila uniforme: texto a la izquierda, control a la derecha. */
	.setting {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 15rem);
		column-gap: clamp(1.25rem, 3vw, 2.5rem);
		align-items: start;
		padding: 0.875rem 0;
		border-bottom: 1px solid var(--border);
	}

	.setting__text {
		min-width: 0;
	}

	.setting__control {
		min-width: 0;
	}

	.setting__label {
		display: block;
		font-size: 0.8125rem;
		font-weight: 600;
		line-height: 1.35;
		letter-spacing: -0.005em;
		overflow-wrap: anywhere;
	}

	.setting__hint {
		margin: 0.3rem 0 0;
		font-size: 0.75rem;
		line-height: 1.5;
		color: var(--muted-foreground);
		overflow-wrap: anywhere;
	}

	.setting__state {
		margin: 0.35rem 0 0;
		font-size: 0.6875rem;
		font-weight: 600;
		line-height: 1.4;
		font-variant-numeric: tabular-nums;
	}

	.setting__state + .setting__hint {
		margin-top: 0.25rem;
	}

	/* Un mismo vocabulario para los dos selectores. */
	.select-wrap {
		position: relative;
		width: 100%;
	}

	.select {
		box-sizing: border-box;
		display: block;
		width: 100%;
		min-height: 2.375rem;
		padding: 0.45rem 2rem 0.45rem 0.7rem;
		appearance: none;
		border: 1px solid var(--input, var(--border));
		border-radius: var(--radius-sm);
		background: var(--card);
		color: var(--foreground);
		font: inherit;
		font-size: 0.8125rem;
		line-height: 1.4;
		cursor: pointer;
		transition:
			background-color var(--dur-180) var(--ease-out),
			border-color var(--dur-180) var(--ease-out);
	}

	.select:hover:not(:disabled) {
		border-color: color-mix(in srgb, var(--foreground) 32%, var(--border));
		background: color-mix(in srgb, var(--accent) 55%, var(--card));
	}

	.select:active:not(:disabled) {
		background: var(--accent);
	}

	.select:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
		border-color: var(--ring);
	}

	.select:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.select-arrow {
		position: absolute;
		top: 50%;
		right: 0.6rem;
		transform: translateY(-50%);
		font-family: "Material Symbols Rounded Variable";
		font-variation-settings: "FILL" 0, "wght" 400, "GRAD" 0, "opsz" 20;
		font-size: 18px;
		line-height: 1;
		color: var(--muted-foreground);
		pointer-events: none;
	}

	/* Interruptor real (checkbox nativo) con estado textual explícito. */
	.switch-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-height: 2.375rem;
	}

	.switch {
		box-sizing: border-box;
		position: relative;
		flex: none;
		width: 2.5rem;
		height: 1.5rem;
		margin: 0;
		appearance: none;
		border: 1px solid var(--input, var(--border));
		border-radius: 9999px;
		background: var(--secondary);
		cursor: pointer;
		transition:
			background-color var(--dur-180) var(--ease-out),
			border-color var(--dur-180) var(--ease-out),
			opacity var(--dur-180) var(--ease-out);
	}

	.switch::after {
		content: "";
		position: absolute;
		top: 2px;
		left: 2px;
		width: calc(1.5rem - 6px);
		height: calc(1.5rem - 6px);
		border-radius: 9999px;
		background: var(--foreground);
		transition:
			transform var(--dur-180) var(--ease-out),
			background-color var(--dur-180) var(--ease-out);
	}

	.switch:checked {
		border-color: transparent;
		background: var(--foreground);
	}

	.switch:checked::after {
		transform: translateX(1rem);
		background: var(--background);
	}

	.switch:hover:not(:disabled) {
		border-color: color-mix(in srgb, var(--foreground) 40%, var(--border));
	}

	.switch:active:not(:disabled) {
		opacity: 0.82;
	}

	.switch:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}

	.switch:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.switch-state {
		font-size: 0.8125rem;
		line-height: 1.4;
		color: var(--muted-foreground);
		font-variant-numeric: tabular-nums;
	}

	.switch:checked + .switch-state {
		color: var(--foreground);
	}

	/* Lectura discreta del dispositivo: el guion también tiene intención. */
	.device-status {
		box-sizing: border-box;
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		max-width: 100%;
		min-height: 2.375rem;
		padding: 0.4rem 0.7rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--muted) 46%, var(--card));
		color: var(--foreground);
		font-size: 0.8125rem;
		font-weight: 500;
		line-height: 1.4;
		font-variant-numeric: tabular-nums;
	}

	.device-status__dot {
		flex: none;
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 9999px;
		background: var(--foreground);
	}

	.device-status.is-empty {
		color: var(--muted-foreground);
	}

	.device-status.is-empty .device-status__dot {
		background: transparent;
		box-shadow: inset 0 0 0 1px var(--muted-foreground);
	}

	.device-status__value {
		overflow-wrap: anywhere;
	}

	@media (max-width: 44rem) {
		.setting {
			grid-template-columns: minmax(0, 1fr);
			row-gap: 0.6rem;
		}

		.setting__control {
			max-width: 22rem;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.select,
		.switch,
		.switch::after {
			transition: none;
		}
	}
</style>
