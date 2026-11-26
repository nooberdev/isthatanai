<script lang="ts">
	import { onMount } from "svelte";
	import {
		IsThatAnAI,
		type ClickSample,
		type InputSample,
		type KeySample,
		type PointerSample,
		type ScrollSample
	} from "is-that-an-ai";
	import CentralWord from "#lib/components/CentralWord.svelte";
	import TrailCanvas from "#lib/components/TrailCanvas.svelte";
	import CustomCursor from "#lib/components/CustomCursor.svelte";
	import PageControls from "#lib/components/PageControls.svelte";
	import ScrollLine from "#lib/components/ScrollLine.svelte";
	import DevPanel from "#lib/components/DevPanel.svelte";
	import ClickTest from "#lib/components/sections/ClickTest.svelte";
	import TypingTest from "#lib/components/sections/TypingTest.svelte";
	import ScrollTest from "#lib/components/sections/ScrollTest.svelte";
	import DragTest from "#lib/components/sections/DragTest.svelte";
	import TouchTest from "#lib/components/sections/TouchTest.svelte";
	import AttentionTest from "#lib/components/sections/AttentionTest.svelte";
	import Breakdown from "#lib/components/sections/Breakdown.svelte";
	import Recorder from "#lib/components/sections/Recorder.svelte";
	import Settings from "#lib/components/sections/Settings.svelte";
	import type { SessionRecord } from "#lib/lab/session";
	import type { VerdictState } from "#lib/motion/verdict.svelte";
	import { getCursorPos, setCursorPos } from "#lib/motion/cursor";
	import { setupSectionReveal } from "#lib/motion/reveal";
	import { live } from "#lib/detector/live.svelte";
	import { i18n, tr, type DemoTranslationKey } from "#lib/i18n";

	const STATE_COLOR: Record<VerdictState, string> = {
		midiendo: "var(--color-verdict-midiendo)",
		humano: "var(--color-verdict-humano)",
		ia: "var(--color-verdict-ia)"
	};

	// Claves de reserva de la Etapa 3: se usan solo si la librería no da razones.
	const FALLBACK_REASON_KEY: Record<VerdictState, DemoTranslationKey> = {
		midiendo: "reason.measuring",
		humano: "reason.human",
		ia: "reason.ai"
	};

	// Números de demostración para los estados forzados (?estado= o panel).
	const DEMO_SCORE: Record<VerdictState, string> = {
		midiendo: "—",
		humano: "0.08",
		ia: "0.94"
	};

	// Etiqueta de pantalla (el estado interno sigue siendo "ia" y el URL ?estado=ia).
	const WORD_KEY: Record<VerdictState, DemoTranslationKey> = {
		midiendo: "word.measuring",
		humano: "word.human",
		ia: "word.ai"
	};

	function wordFor(state: VerdictState): string {
		return tr(WORD_KEY[state]);
	}

	function fallbackReasonFor(state: VerdictState): string {
		return tr(FALLBACK_REASON_KEY[state]);
	}

	// Estado de la librería -> estado visual de la demo.
	const LIB_TO_STATE: Record<string, VerdictState> = {
		measuring: "midiendo",
		human: "humano",
		ai: "ia"
	};

	// La duda no cambia el estado: matiza el veredicto actual. El "?" aparece
	// desde 0.35 y desaparece cuando la duda baja, sin reveal ni texto nuevo.
	const DOUBT_THRESHOLD = 0.35;

	function clamp01(n: number): number {
		return Math.min(1, Math.max(0, n));
	}

	// Mezcla en srgb con los tokens de :root, sin duplicar los hex en JS.
	// El porcentaje del color base baja con la duda; el extremo dudoso sube.
	function stateColor(state: VerdictState, doubt: number): string {
		if (state === "humano" || state === "ia") {
			const base = state === "humano" ? "--color-verdict-humano" : "--color-verdict-ia";
			const end =
				state === "humano" ? "--color-verdict-humano-doubt" : "--color-verdict-ia-doubt";
			const pct = Math.round((1 - clamp01(doubt)) * 100);
			return `color-mix(in srgb, var(${base}) ${pct}%, var(${end}))`;
		}
		return STATE_COLOR[state];
	}

	function stateFromLib(state: string): VerdictState {
		return LIB_TO_STATE[state] ?? "midiendo";
	}

	let revealId = $state(0);
	let revealPos = $state({ x: 0, y: 0 });
	let baseState = $state<VerdictState>("midiendo");
	let prevCommitted = $state<VerdictState>("midiendo");
	let willClip = $state(false);

	// El hero conserva su propio eje con --hero-progress; la línea inferior es
	// siempre completa y solo cambia de color con el veredicto.
	let heroEl = $state<HTMLElement | null>(null);

	// Instancia única, creada en onMount (nunca a nivel de módulo: SSR-safe).
	let detector = $state<IsThatAnAI | null>(null);

	// Veredicto REAL de la librería, leído del sondeo compartido (160 ms).
	// onVerdict fuerza una lectura inmediata al cambiar de estado.
	let libVerdict = $derived(live.verdict);
	let libState = $derived(stateFromLib(live.verdict.state));

	// Overrides explícitos de la demo: ?estado=... gana siempre (capturas);
	// los botones del panel son un override manual cuando no hay URL.
	let urlOverride = $state<VerdictState | null>(null);
	let manualOverride = $state<VerdictState | null>(null);

	// Preferencias de la demo, en memoria: las controla PageControls.
	let trailEnabled = $state(true);
	let cursorEnabled = $state(true);

	// Sesión grabada/importada, compartida por el grabador y el visualizador.
	let recordedSession = $state<SessionRecord | null>(null);
	function setRecordedSession(next: SessionRecord | null): void {
		recordedSession = next;
	}

	let effectiveState = $derived(urlOverride ?? manualOverride ?? libState);

	function setManualOverride(s: VerdictState): void {
		manualOverride = s;
	}

	// Reinicio en caliente: la misma instancia se detiene y arranca; stop()
	// devuelve la librería a "measuring". Los overrides siguen ganando porque
	// effectiveState los consulta antes que libState.
	function resetSession(): void {
		const d = detector;
		if (d) {
			d.stop();
			d.start();
		}
		live.pump();
	}

	// Getters incrementales por seq: los usa el grabador (DevPanel y Recorder),
	// que necesita TODAS las muestras nuevas, no solo la ventana reciente.
	function readRecentPoints(sinceSeq?: number): PointerSample[] {
		return detector ? detector.getRecentPoints(sinceSeq) : [];
	}

	function readRecentClicks(sinceSeq?: number): ClickSample[] {
		return detector ? detector.getRecentClicks(sinceSeq) : [];
	}

	function readRecentScrolls(sinceSeq?: number): ScrollSample[] {
		return detector ? detector.getRecentScrolls(sinceSeq) : [];
	}

	function readRecentKeys(sinceSeq?: number): KeySample[] {
		return detector ? detector.getRecentKeys(sinceSeq) : [];
	}

	function readRecentInputs(sinceSeq?: number): InputSample[] {
		return detector ? detector.getRecentInputs(sinceSeq) : [];
	}

	// En interacción normal manda el número real; en estados forzados se mantienen
	// los valores de demostración aprobados para las capturas.
	let isForced = $derived(urlOverride !== null || manualOverride !== null);
	let scoreText = $derived(
		isForced
			? DEMO_SCORE[effectiveState]
			: libVerdict.score === null
				? "—"
				: libVerdict.score.toFixed(2)
	);
	let reasonText = $derived(
		isForced
			? fallbackReasonFor(effectiveState)
			: libVerdict.reasons.length > 0
				? libVerdict.reasons[0]
				: fallbackReasonFor(effectiveState)
	);

	// La duda llega con cada sondeo (4 Hz) y se aplica al MISMO veredicto:
	// sube y baja sin cambiar state. En overrides (?estado= o panel) se fija en 0
	// para que las capturas muestren siempre HUMANO / AGENTE sin "?".
	let doubt = $derived(isForced ? 0 : clamp01(libVerdict.doubt ?? 0));
	let showQuestion = $derived(
		(effectiveState === "humano" || effectiveState === "ia") && doubt >= DOUBT_THRESHOLD
	);
	let baseColor = $derived(stateColor(baseState, doubt));
	let topColor = $derived(stateColor(effectiveState, doubt));

	// La línea usa exactamente el color del hero, con el mismo matiz de duda.
	let lineColor = $derived(stateColor(effectiveState, doubt));

	function reduces(): boolean {
		return (
			typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
		);
	}

	// Círculo de reveal: igual para cualquier cambio (incluido volver a midiendo).
	$effect(() => {
		const committed = effectiveState;
		if (committed === prevCommitted) return;
		revealId += 1;
		revealPos = { ...getCursorPos() };
		if (reduces()) {
			baseState = committed;
		} else {
			willClip = true;
		}
		prevCommitted = committed;
	});

	function onRevealEnd(): void {
		willClip = false;
		baseState = effectiveState;
	}

	// Override determinístico para las capturas: ?estado=midiendo|humano|ia
	function stateFromUrl(): VerdictState | null {
		if (typeof window === "undefined") return null;
		const param = new URLSearchParams(window.location.search).get("estado");
		if (param === "midiendo" || param === "humano" || param === "ia") return param;
		return null;
	}

	onMount(() => {
		// El idioma del sistema se resuelve aquí, nunca al importar el módulo.
		i18n.init();
		urlOverride = stateFromUrl();
		setupSectionReveal();

		// Progreso 0→1 del hero: el contenido se desvanece con la misma curva.
		// Se publica como --hero-progress para la salida del hero, sin cambios.
		const updateScroll = () => {
			const heroHeight = heroEl?.offsetHeight ?? window.innerHeight;
			const p = clamp01(window.scrollY / Math.max(heroHeight, 1));
			document.documentElement.style.setProperty("--hero-progress", p.toFixed(4));
		};
		window.addEventListener("scroll", updateScroll, { passive: true });
		updateScroll();

		// Única instancia de la librería: se crea y arranca aquí, nunca en el módulo.
		const instance = new IsThatAnAI({
			mouse: { bufferSize: 400, maxAgeMs: 4000 },
			locale: i18n.locale
		});
		detector = instance;
		i18n.attach(instance);
		instance.start();
		live.connect(instance);
		const offVerdict = instance.onVerdict(() => live.pump());

		// Este listener es SOLO para posicionar el círculo de reveal (#lib/motion/cursor).
		// NO es la fuente de datos del trazo: ese viene del colector del detector.
		const onRevealPointer = (e: PointerEvent) => {
			setCursorPos(e.clientX, e.clientY);
		};
		window.addEventListener("pointermove", onRevealPointer, { passive: true });

		return () => {
			offVerdict();
			i18n.detach();
			live.disconnect();
			window.removeEventListener("scroll", updateScroll);
			window.removeEventListener("pointermove", onRevealPointer);
			instance.stop();
			detector = null;
		};
	});
</script>

<svelte:head>
	<title>is that an ai?</title>
</svelte:head>

<main class="page-root">
	<div class="hero-snap-anchor" aria-hidden="true"></div>
	<section class="hero" data-state={effectiveState} bind:this={heroEl}>
		<TrailCanvas {detector} score={libVerdict.score} enabled={trailEnabled} />
		<div
			class="verdict-layers"
			style="--base-color: {baseColor}; --top-color: {topColor}"
		>
			<div class="verdict-layer verdict-layer--base"></div>
			{#if revealId > 0}
				{#key revealId}
					<div
						class="verdict-layer verdict-layer--reveal"
						class:will-clip={willClip}
						style="--rx: {revealPos.x}px; --ry: {revealPos.y}px; background: var(--top-color)"
						onanimationend={onRevealEnd}
					></div>
				{/key}
			{/if}
		</div>
		<div class="hero-content">
			<CentralWord word={wordFor(effectiveState)} question={showQuestion} />
			<p class="score-line">
				<span class="score">{scoreText}</span>
				<span class="score-reason"> · {reasonText}</span>
			</p>
		</div>
	</section>

	<div class="sections-sheet">
		<ClickTest />
		<TypingTest />
		<ScrollTest />
		<DragTest />
		<TouchTest />
		<AttentionTest />
		<Breakdown />
		<Recorder
			getRecentPoints={readRecentPoints}
			getRecentClicks={readRecentClicks}
			getRecentScrolls={readRecentScrolls}
			getRecentKeys={readRecentKeys}
			getRecentInputs={readRecentInputs}
			{detector}
			session={recordedSession}
			onSession={setRecordedSession}
		/>
		<Settings {detector} />
	</div>
</main>

<PageControls bind:trailEnabled bind:cursorEnabled onReset={resetSession} />

<ScrollLine color={lineColor} />

<CustomCursor enabled={cursorEnabled} />

{#if import.meta.env.DEV}
	<DevPanel
		currentState={effectiveState}
		onSetState={setManualOverride}
		getRecentPoints={readRecentPoints}
		getRecentClicks={readRecentClicks}
		getRecentScrolls={readRecentScrolls}
		getRecentKeys={readRecentKeys}
		getRecentInputs={readRecentInputs}
		forced={urlOverride !== null || manualOverride !== null}
	/>
{/if}
