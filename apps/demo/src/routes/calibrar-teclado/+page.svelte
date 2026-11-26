<script lang="ts">
	import { onMount } from "svelte";
	import { IsThatAnAI, type InputSample, type KeySample } from "is-that-an-ai";

	// Ruta oculta de calibración. AVISO: el sitio es estático (prerender = true),
	// así que esta clave NO es seguridad: solo mantiene la herramienta "no
	// enlazada" y evita mostrarla por accidente. El bundle es público. No se
	// enlaza desde ningún menú ni se indexa.
	const SECRET = "calibra-2026";

	// Párrafo objetivo fijo, en español real. Nunca se guarda ni se exporta.
	const TARGET =
		"Hoy salí temprano, caminé hasta la esquina y compré pan recién horneado. Mi hermana me esperaba en la cocina con una taza de café, y charlamos hasta que el reloj marcó las nueve.";

	const LONG_PAUSE_MS = 1000;
	const CHARS_PER_WORD = 5;
	const POLL_MS = 200;

	// La clave se consulta en onMount: el HTML prerenderizado y el primer render
	// del cliente coinciden ("No disponible"), sin mismatch de hidratación.
	let authorized = $state(false);
	let detector = $state<IsThatAnAI | null>(null);

	// Los valores de los campos viven SOLO en memoria mientras la página está
	// abierta: hacen falta para la precisión carácter a carácter. No se
	// exportan, no se envían y no se escriben en storage.
	let typed = $state("");
	let pasteValue = $state("");

	let startedAtMs = $state<number | null>(null);
	let completedAtMs = $state<number | null>(null);
	let nowMs = $state(0);

	// Solo tiempos y categorías numéricas (lo que ya expone la librería),
	// acumulados por seq para no perder muestras cuando el buffer descarta
	// las de más de 15 s. Nunca hay texto aquí.
	let keyTimeline = $state<KeySample[]>([]);
	let inputTimeline = $state<InputSample[]>([]);
	let lastKeySeq = 0;
	let lastInputSeq = 0;

	let keyboardScore = $state<number | null>(null);

	let typedChars = $derived(typed.length);
	let targetChars = TARGET.length;
	let elapsedMs = $derived(startedAtMs === null ? 0 : Math.max(0, nowMs - startedAtMs));

	let keyDowns = $derived(keyTimeline.reduce((n, k) => n + (k.kind === 0 ? 1 : 0), 0));
	let backspaces = $derived(
		keyTimeline.reduce((n, k) => n + (k.kind === 0 && k.category === 3 ? 1 : 0), 0)
	);
	let longPauses = $derived(countLongPauses(keyTimeline));
	let pasteCount = $derived(inputTimeline.reduce((n, i) => n + (i.inputType === 1 ? 1 : 0), 0));

	let accuracy = $derived(computeAccuracy(typed, TARGET));
	let wpm = $derived(computeWpm(typedChars, elapsedMs));

	let wpmText = $derived(typedChars === 0 ? "—" : wpm.toFixed(1));
	let accuracyText = $derived(typedChars === 0 ? "—" : `${(accuracy * 100).toFixed(1)}%`);
	let timeText = $derived(`${(elapsedMs / 1000).toFixed(1)} s`);
	let scoreText = $derived(keyboardScore === null ? "—" : keyboardScore.toFixed(2));
	let signalText = $derived(
		keyboardScore === null ? "Sin señal suficiente" : "Señal suficiente"
	);

	function countLongPauses(keys: KeySample[]): number {
		let count = 0;
		let previous: number | null = null;
		for (const key of keys) {
			if (key.kind !== 0) continue;
			if (previous !== null && key.t - previous > LONG_PAUSE_MS) count += 1;
			previous = key.t;
		}
		return count;
	}

	// Coincidencia posición a posición. Los caracteres sobrantes cuentan como
	// fallo; devuelve una fracción 0..1 (en la exportación `accuracy` es 0..1).
	function computeAccuracy(value: string, target: string): number {
		if (value.length === 0) return 0;
		const n = Math.min(value.length, target.length);
		let correct = 0;
		for (let i = 0; i < n; i += 1) {
			if (value[i] === target[i]) correct += 1;
		}
		return correct / value.length;
	}

	function computeWpm(chars: number, ms: number): number {
		if (ms <= 0 || chars === 0) return 0;
		return chars / CHARS_PER_WORD / (ms / 60000);
	}

	function sync(): void {
		const d = detector;
		if (!d) return;

		const freshKeys = d.getRecentKeys(lastKeySeq);
		for (const key of freshKeys) {
			if (key.seq > lastKeySeq) lastKeySeq = key.seq;
		}
		if (freshKeys.length > 0) keyTimeline = [...keyTimeline, ...freshKeys];

		const freshInputs = d.getRecentInputs(lastInputSeq);
		for (const input of freshInputs) {
			if (input.seq > lastInputSeq) lastInputSeq = input.seq;
		}
		if (freshInputs.length > 0) inputTimeline = [...inputTimeline, ...freshInputs];

		keyboardScore = d.getSignalScores().keyboard;
		nowMs = Date.now();
	}

	function onTypingInput(event: Event): void {
		const value = (event.currentTarget as HTMLTextAreaElement).value;
		if (startedAtMs === null) startedAtMs = Date.now();
		if (completedAtMs === null && value.length >= TARGET.length) completedAtMs = Date.now();
		nowMs = Date.now();
	}

	function reset(): void {
		typed = "";
		pasteValue = "";
		startedAtMs = null;
		completedAtMs = null;
		nowMs = Date.now();
		keyTimeline = [];
		inputTimeline = [];
		lastKeySeq = 0;
		lastInputSeq = 0;
		keyboardScore = null;
		// Reinicia también los buffers de la librería para que los seq vuelvan a 0.
		const d = detector;
		if (d) {
			d.stop();
			d.start();
		}
	}

	function exportJson(): void {
		const d = detector;
		if (!d) return;

		const keys = d.getRecentKeys(0);
		const inputs = d.getRecentInputs(0);

		// `keyboard` y `keyCount`/`inputCount` son no enumerables en la librería:
		// los copiamos explícitamente para que aparezcan en el JSON.
		const rawScores = d.getSignalScores();
		const signalScores = {
			mouse: rawScores.mouse,
			click: rawScores.click,
			scroll: rawScores.scroll,
			keyboard: rawScores.keyboard
		};
		const rawStats = d.getStats();
		const stats = {
			sampleCount: rawStats.sampleCount,
			droppedCount: rawStats.droppedCount,
			eventsPerSecond: rawStats.eventsPerSecond,
			bufferFill: rawStats.bufferFill,
			trustedRatio: rawStats.trustedRatio,
			lastEventAt: rawStats.lastEventAt,
			clickCount: rawStats.clickCount,
			scrollCount: rawStats.scrollCount,
			keyCount: rawStats.keyCount,
			inputCount: rawStats.inputCount
		};

		const ended = completedAtMs ?? Date.now();
		const payload = {
			version: 1,
			label: "humano",
			startedAt: new Date(startedAtMs ?? ended).toISOString(),
			endedAt: new Date(ended).toISOString(),
			durationMs: startedAtMs === null ? 0 : Math.max(0, ended - startedAtMs),
			wpm: Number(wpm.toFixed(2)),
			accuracy: Number(accuracy.toFixed(4)),
			targetChars: TARGET.length,
			typedChars: typed.length,
			keys,
			inputs,
			signalScores,
			stats
		};

		// Sin red ni storage: solo un Blob local y un enlace temporal.
		const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = "calibracion-teclado.json";
		document.body.appendChild(link);
		link.click();
		link.remove();
		setTimeout(() => URL.revokeObjectURL(url), 0);
	}

	onMount(() => {
		const params = new URLSearchParams(window.location.search);
		authorized = params.get("clave") === SECRET;
		if (!authorized) return;

		nowMs = Date.now();
		// Instancia propia: no toca la de la ruta principal.
		const instance = new IsThatAnAI();
		detector = instance;
		instance.start();
		const timer = setInterval(sync, POLL_MS);
		sync();

		return () => {
			clearInterval(timer);
			instance.stop();
			detector = null;
		};
	});
</script>

<svelte:head>
	<title>{authorized ? "Calibrar teclado" : "No disponible"}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

{#if authorized}
	<main class="min-h-dvh bg-background px-4 py-10 sm:px-6">
		<div
			class="mx-auto box-border w-full max-w-2xl rounded-lg border border-border bg-card px-5 py-6 sm:px-7 sm:py-7"
		>
			<h1 class="text-xl font-semibold tracking-tight sm:text-2xl">Calibrar teclado</h1>
			<p class="mt-1.5 text-sm text-muted-foreground">
				Escribe el texto objetivo sin pegarlo; solo se miden tiempos y ritmo.
			</p>

			<p class="mt-5 break-words border-l-2 border-border pl-3 text-sm leading-relaxed">
				{TARGET}
			</p>

			<div class="mt-6 space-y-5">
				<div class="min-w-0">
					<label for="cal-typing" class="block text-sm font-medium">Tu escritura</label>
					<textarea
						id="cal-typing"
						rows="4"
						spellcheck="false"
						autocomplete="off"
						bind:value={typed}
						oninput={onTypingInput}
						onpaste={(event) => event.preventDefault()}
						class="mt-2 block w-full min-w-0 box-border resize-y rounded-md border border-input bg-background px-3 py-2.5 text-[15px] leading-relaxed outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
					></textarea>
				</div>

				<dl class="flex flex-wrap gap-x-6 gap-y-3 border-t border-border pt-4">
					<div class="min-w-0">
						<dt class="text-xs text-muted-foreground">Tiempo</dt>
						<dd class="text-base font-medium tabular-nums">{timeText}</dd>
					</div>
					<div class="min-w-0">
						<dt class="text-xs text-muted-foreground">WPM</dt>
						<dd class="text-base font-medium tabular-nums">{wpmText}</dd>
					</div>
					<div class="min-w-0">
						<dt class="text-xs text-muted-foreground">Precisión</dt>
						<dd class="text-base font-medium tabular-nums">{accuracyText}</dd>
					</div>
					<div class="min-w-0">
						<dt class="text-xs text-muted-foreground">Teclas</dt>
						<dd class="text-base font-medium tabular-nums">{keyDowns}</dd>
					</div>
					<div class="min-w-0">
						<dt class="text-xs text-muted-foreground">Correcciones</dt>
						<dd class="text-base font-medium tabular-nums">{backspaces}</dd>
					</div>
					<div class="min-w-0">
						<dt class="text-xs text-muted-foreground">Pausas largas</dt>
						<dd class="text-base font-medium tabular-nums">{longPauses}</dd>
					</div>
				</dl>

				<p class="text-sm">
					<span class="text-muted-foreground">Score de teclado</span>
					<span class="ml-2 font-medium tabular-nums">{scoreText}</span>
					<span class="text-muted-foreground"> · {signalText}</span>
				</p>

				<div class="min-w-0">
					<label for="cal-paste" class="block text-sm font-medium">Pegado opcional</label>
					<p class="mt-1 text-xs text-muted-foreground">
						Pega aquí el mismo texto con Ctrl+V o desde el menú contextual.
					</p>
					<textarea
						id="cal-paste"
						rows="2"
						bind:value={pasteValue}
						class="mt-2 block w-full min-w-0 box-border resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
					></textarea>
					<p class="mt-1.5 text-xs text-muted-foreground">
						Pegados detectados: {pasteCount}
					</p>
				</div>

				<div class="flex flex-wrap items-center gap-2 border-t border-border pt-4">
					<button
						type="button"
						onclick={reset}
						class="rounded-md border border-border bg-card px-3 py-2 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						Reiniciar prueba
					</button>
					<button
						type="button"
						onclick={exportJson}
						class="rounded-md border border-primary bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						Exportar JSON
					</button>
				</div>
			</div>
		</div>
	</main>
{:else}
	<main class="grid min-h-dvh place-items-center px-4">
		<p class="text-sm text-muted-foreground">No disponible.</p>
	</main>
{/if}
