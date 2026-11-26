<script lang="ts">
	import { onMount } from "svelte";
	import {
		IsThatAnAI,
		type ClickSample,
		type MouseFeatures,
		type PointerSample,
		type ScrollSample,
		type Verdict
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
	import BotSimulator from "#lib/components/sections/BotSimulator.svelte";
	import Recorder from "#lib/components/sections/Recorder.svelte";
	import Settings from "#lib/components/sections/Settings.svelte";
	import type { VerdictState } from "#lib/motion/verdict.svelte";
	import { getCursorPos, setCursorPos } from "#lib/motion/cursor";
	import { setupSectionReveal } from "#lib/motion/reveal";

	// Forma estructural de las señales que expone la librería (una por señal,
	// null cuando no hay evidencia). Se declara aquí para no depender de un tipo
	// con nombre y mantener el acoplamiento solo a la forma del valor.
	interface SignalScores {
		mouse: number | null;
		click: number | null;
		scroll: number | null;
	}

	const STATE_COLOR: Record<VerdictState, string> = {
		midiendo: "var(--color-verdict-midiendo)",
		humano: "var(--color-verdict-humano)",
		ia: "var(--color-verdict-ia)"
	};

	// Colores planos de la línea de scroll, distintos de los del hero: mismo
	// relleno drenched que antes, ahora como indicador inferior.
	const LINE_FILL: Record<VerdictState, string> = {
		midiendo: "#E5E5EA",
		humano: "#B4FF2E",
		ia: "#FF432E"
	};
	const LINE_DOUBT_FILL = "#FFC400";

	// Textos de reserva de la Etapa 3: se usan solo si la librería no da razones.
	const FALLBACK_REASON: Record<VerdictState, string> = {
		midiendo: "esperando movimiento",
		humano: "movimiento natural, ritmo irregular",
		ia: "trayectoria sintética, ritmo uniforme"
	};

	// Números de demostración para los estados forzados (?estado= o panel).
	const DEMO_SCORE: Record<VerdictState, string> = {
		midiendo: "—",
		humano: "0.08",
		ia: "0.94"
	};

	// Etiqueta de pantalla (el estado interno sigue siendo "ia" y el URL ?estado=ia).
	const WORD: Record<VerdictState, string> = {
		midiendo: "MIDIENDO",
		humano: "HUMANO",
		ia: "AGENTE"
	};

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

	// Veredicto REAL de la librería. onVerdict avisa cambios de estado y el
	// sondeo a 4 Hz mantiene score/confidence/reasons/doubt al día.
	let libVerdict = $state<Verdict>({
		state: "measuring",
		score: null,
		confidence: 0,
		doubt: 0,
		reasons: []
	});
	let libState = $state<VerdictState>("midiendo");

	// Overrides explícitos de la demo: ?estado=... gana siempre (capturas);
	// los botones del panel son un override manual cuando no hay URL.
	let urlOverride = $state<VerdictState | null>(null);
	let manualOverride = $state<VerdictState | null>(null);

	// Preferencias de la demo, en memoria: las controla PageControls.
	let trailEnabled = $state(true);
	let cursorEnabled = $state(true);

	let effectiveState = $derived(urlOverride ?? manualOverride ?? libState);

	function setManualOverride(s: VerdictState): void {
		manualOverride = s;
	}

	function applyVerdict(v: Verdict): void {
		libVerdict = v;
		libState = stateFromLib(v.state);
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
		applyVerdict({ state: "measuring", score: null, confidence: 0, doubt: 0, reasons: [] });
	}

	// El panel necesita un objeto aunque todavía no haya instancia.
	function readStats() {
		const s = detector?.getStats();
		return {
			sampleCount: s?.sampleCount ?? 0,
			droppedCount: s?.droppedCount ?? 0,
			eventsPerSecond: s?.eventsPerSecond ?? 0,
			bufferFill: s?.bufferFill ?? 0,
			trustedRatio: s?.trustedRatio ?? 0,
			lastEventAt: s?.lastEventAt ?? 0,
			clickCount: s?.clickCount ?? 0,
			scrollCount: s?.scrollCount ?? 0
		};
	}

	function readVerdict(): Verdict {
		return libVerdict;
	}

	// Sondeadores para DevPanel (calibración): usamos la instancia única.
	function readMouseFeatures(): MouseFeatures | null {
		return detector?.getMouseFeatures() ?? null;
	}

	function readRecentPoints(sinceSeq?: number): PointerSample[] {
		return detector ? detector.getRecentPoints(sinceSeq) : [];
	}

	function readSignalScores(): SignalScores {
		return detector?.getSignalScores() ?? { mouse: null, click: null, scroll: null };
	}

	function readRecentClicks(sinceSeq?: number): ClickSample[] {
		return detector ? detector.getRecentClicks(sinceSeq) : [];
	}

	function readRecentScrolls(sinceSeq?: number): ScrollSample[] {
		return detector ? detector.getRecentScrolls(sinceSeq) : [];
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
			? FALLBACK_REASON[effectiveState]
			: libVerdict.reasons.length > 0
				? libVerdict.reasons[0]
				: FALLBACK_REASON[effectiveState]
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

	// Color de la línea: el estado manda; la duda sustituye el color por ámbar
	// plano a través de la misma prop `color`.
	let lineColor = $derived(
		effectiveState === "midiendo"
			? LINE_FILL.midiendo
			: showQuestion
				? LINE_DOUBT_FILL
				: LINE_FILL[effectiveState]
	);

	// Sondeo ~4 Hz: onVerdict solo dispara al cambiar el estado.
	$effect(() => {
		const d = detector;
		if (!d) return;
		const sync = () => applyVerdict(d.getVerdict());
		sync();
		const id = setInterval(sync, 250);
		return () => clearInterval(id);
	});

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
		const instance = new IsThatAnAI({ mouse: { bufferSize: 400, maxAgeMs: 4000 } });
		detector = instance;
		instance.start();
		applyVerdict(instance.getVerdict());
		const offVerdict = instance.onVerdict(applyVerdict);

		// Este listener es SOLO para posicionar el círculo de reveal (#lib/motion/cursor).
		// NO es la fuente de datos del trazo: ese viene del colector del detector.
		const onRevealPointer = (e: PointerEvent) => {
			setCursorPos(e.clientX, e.clientY);
		};
		window.addEventListener("pointermove", onRevealPointer, { passive: true });

		return () => {
			offVerdict();
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
			<CentralWord word={WORD[effectiveState]} question={showQuestion} />
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
		<BotSimulator />
		<Recorder />
		<Settings />
	</div>
</main>

<PageControls bind:trailEnabled bind:cursorEnabled onReset={resetSession} />

<ScrollLine color={lineColor} />

<CustomCursor enabled={cursorEnabled} />

{#if import.meta.env.DEV}
	<DevPanel
		currentState={effectiveState}
		onSetState={setManualOverride}
		getStats={readStats}
		getVerdict={readVerdict}
		getMouseFeatures={readMouseFeatures}
		getRecentPoints={readRecentPoints}
		getSignalScores={readSignalScores}
		getRecentClicks={readRecentClicks}
		getRecentScrolls={readRecentScrolls}
		forced={urlOverride !== null || manualOverride !== null}
	/>
{/if}
