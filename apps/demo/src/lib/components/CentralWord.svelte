<script lang="ts">
	import { untrack } from "svelte";

	let { word = '', question = false }: { word: string; question?: boolean } = $props();

	interface Letter {
		ch: string;
		id: number;
		index: number;
	}

	let letters = $state<Letter[]>([]);
	let exiting = $state<Letter[]>([]);
	let rootEl = $state<HTMLSpanElement | null>(null);
	let questionEl = $state<HTMLSpanElement | null>(null);
	let reduceMotion = $state(false);
	let exitTimer: ReturnType<typeof setTimeout> | undefined;
	let nextId = 1;

	const supportsScrollTimeline =
		typeof CSS !== 'undefined' && CSS.supports('animation-timeline', 'scroll()');

	function reduces(): boolean {
		return (
			typeof window !== 'undefined' &&
			window.matchMedia('(prefers-reduced-motion: reduce)').matches
		);
	}

	// El "?" vive fuera del flujo (`left: 100%`), así que al aparecer hay que
	// correr el conjunto medio ancho del signo. Se mide el ancho de layout
	// (`offsetWidth`, independiente de `transform`) para que el valor sirva con
	// cualquier font-size y no se vea afectado por `wordShrink` ni por el scale
	// del propio fundido.
	function measureQuestion(): void {
		if (!questionEl || !rootEl) return;
		rootEl.style.setProperty('--question-shift', `${questionEl.offsetWidth / 2}px`);
	}

	$effect(() => {
		// Dependencias: el nodo del signo, el contenedor y la palabra (el
		// font-size depende de vw, así que también re-medimos al redimensionar).
		void word;
		if (!questionEl || !rootEl || typeof window === 'undefined') return;
		measureQuestion();
		let active = true;
		void document.fonts?.ready.then(() => {
			if (active) measureQuestion();
		});
		window.addEventListener('resize', measureQuestion);
		return () => {
			active = false;
			window.removeEventListener('resize', measureQuestion);
		};
	});

	function build(w: string): Letter[] {
		return w.toUpperCase().split('').map((ch, i) => ({ ch, id: nextId++, index: i }));
	}

	$effect(() => {
		const w = word;
		const prevLetters = untrack(() => letters);
		const prevExiting = untrack(() => exiting);
		if (prevLetters.length === 0 && prevExiting.length === 0) {
			letters = build(w);
			return;
		}
		const next = build(w);
		const out = prevLetters.map((l, i) => ({ ...l, index: i }));
		letters = next;
		if (reduces()) {
			exiting = [];
		} else {
			exiting = out;
			if (exitTimer) clearTimeout(exitTimer);
			exitTimer = setTimeout(() => {
				exiting = [];
			}, 700);
		}
	});

	$effect(() => () => {
		if (exitTimer) clearTimeout(exitTimer);
	});

	$effect(() => {
		if (typeof window === 'undefined') return;
		reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	});

	// Fallback para navegadores sin `animation-timeline: scroll()`: la palabra se
	// reduce y sube un poco según el avance del scroll (por JavaScript).
	// Mismo rango que `animation-range: 0 60svh`: 0% -> 0.82 scale, -8%.
	$effect(() => {
		if (!rootEl || supportsScrollTimeline) return;
		const el = rootEl;
		const onScroll = () => {
			const range = 0.6 * window.innerHeight;
			const t = Math.min(1, Math.max(0, window.scrollY / range));
			el.style.transform = `scale(${1 - 0.18 * t}) translateY(${-8 * t}%)`;
		};
		window.addEventListener('scroll', onScroll);
		onScroll();
		return () => window.removeEventListener('scroll', onScroll);
	});
</script>

<span
	class="word"
	bind:this={rootEl}
	class:no-motion={reduceMotion}
	class:breathing={!reduceMotion && word.toUpperCase() === "MIDIENDO"}
>
	<span class="word-inner" class:questioning={question}>
		<span class="word-letters">
			{#each exiting as letter (letter.id)}
				<span class="letter letter--out" style="--i: {letter.index}"><span class="glyph">{letter.ch}</span></span>
			{/each}
		</span>
		<span class="word-letters">
			{#each letters as letter (letter.id)}
				<span class="letter letter--in" style="--i: {letter.index}"><span class="glyph">{letter.ch}</span></span>
			{/each}
		</span>
		<!-- Sospecha reversible del MISMO veredicto: no es un estado nuevo. -->
		<span class="question" class:visible={question} bind:this={questionEl}>?</span>
	</span>
</span>

<style>
	/* La palabra es el objeto dominante del hero. Dos grids apilados (uno por
	   palabra saliente/entrante), ambos centrados en la misma caja. */
	.word {
		position: relative;
		display: inline-grid;
		width: fit-content;
		justify-self: center;
		white-space: nowrap;
		font-size: clamp(2.75rem, 18vw, 18rem);
		font-weight: 600;
		letter-spacing: -0.045em;
		line-height: 0.9;
		color: var(--word-ink);
		animation-name: wordShrink;
		animation-timeline: scroll();
		animation-duration: 0s;
		animation-fill-mode: both;
		animation-range: 0 60svh;
	}

	/* Contenedor de la unidad palabra + "?". El ajuste usa `translate`, una
	   propiedad independiente: no sobrescribe el `transform` de `wordShrink`,
	   el del fallback por JS ni el scale de las letras. Al vivir dentro de
	   `.word`, el scale del scroll escala también el corrimiento. */
	.word-inner {
		position: relative;
		display: inline-grid;
		width: fit-content;
		grid-area: 1/1;
		justify-self: center;
		translate: 0 0;
		transition: translate var(--dur-320) var(--ease-out);
	}

	.word-inner.questioning {
		translate: calc(-1 * var(--question-shift, 0px)) 0;
	}

	.word.breathing {
		animation-name: wordBreathe;
		animation-duration: 2.4s;
		animation-timeline: auto;
		animation-iteration-count: infinite;
		animation-timing-function: var(--ease-in-out);
	}

	/* El "?" se superpone al final (`.word-inner` absorbe el corrimiento):
	   fundido + scale sutil, reversible en ambos sentidos (~300ms). */
	.question {
		position: absolute;
		left: 100%;
		top: 0;
		opacity: 0;
		transform: scale(0.82);
		transform-origin: left center;
		transition: opacity var(--dur-320) var(--ease-out), transform var(--dur-320) var(--ease-out);
		pointer-events: none;
	}

	.question.visible {
		opacity: 1;
		transform: scale(1);
	}

	@media (prefers-reduced-motion: reduce) {
		.question,
		.question.visible {
			transition: none;
			transform: none;
		}

		/* El centrado salta directo; el "?" conserva su comportamiento actual. */
		.word-inner,
		.word-inner.questioning {
			transition: none;
		}
	}

	/* En pantallas <533px el mínimo de 6rem cortaba MIDIENDO/HUMANO; el mínimo
	   baja solo ahí, el resto del clamp (18vw .. 18rem) queda igual. */
	.word.no-motion {
		animation: none;
	}

	.word-letters {
		grid-area: 1/1;
		justify-self: center;
		display: grid;
		grid-auto-flow: column;
	}

	.letter {
		display: inline-block;
		overflow: hidden;
		height: 1em;
		vertical-align: top;
	}

	.glyph {
		display: block;
		transform: translateY(100%);
		opacity: 0;
	}

	.letter--in .glyph {
		animation: letterEnter var(--dur-320) var(--ease-out) forwards;
		animation-delay: calc(var(--i) * 25ms);
	}

	.letter--out .glyph {
		transform: translateY(0);
		opacity: 1;
		animation: letterExit var(--dur-320) var(--ease-out) forwards;
		animation-delay: calc(var(--i) * 25ms);
	}

	.no-motion .glyph {
		animation: none;
		transform: translateY(0);
		opacity: 1;
	}

	@keyframes wordShrink {
		from {
			transform: scale(1) translateY(0);
		}
		to {
			transform: scale(0.82) translateY(-8%);
		}
	}

	@keyframes wordBreathe {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.85;
		}
	}

	@keyframes letterEnter {
		from {
			transform: translateY(100%);
			opacity: 0;
		}
		to {
			transform: translateY(0);
			opacity: 1;
		}
	}

	@keyframes letterExit {
		from {
			transform: translateY(0);
			opacity: 1;
		}
		to {
			transform: translateY(-110%);
			opacity: 0;
		}
	}
</style>
