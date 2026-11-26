<script lang="ts">
	// Trazo pixel art, inspirado en el juego de referencia: una rejilla gruesa
	// (PIXEL px de CSS por celda), degradado verde -> amarillo -> naranja -> rojo
	// y dos celdas de grosor (línea más gruesa, sin halo).
	const FADE_MS = 1100;
	const PIXEL = 3;
	const THICKNESS = 3;
	const MAX_POINTS = 400;

	// Superficie mínima que consume este componente del detector de la librería.
	// Estructural: cualquier objeto con getRecentPoints sirve (sin acoplar tipos).
	interface TrailSample {
		seq: number;
		x: number;
		y: number;
		t: number;
		kind?: number;
	}

	interface TrailDetector {
		getRecentPoints(sinceSeq?: number): TrailSample[];
	}

	interface TrailPoint {
		x: number;
		y: number;
		t: number;
		// kind 1 (enter) / 2 (leave) => corte duro, no se conecta ningún segmento.
		gap: boolean;
		// Score de la librería vigente cuando se consumió esta muestra.
		score: number;
	}

	interface Rgb {
		r: number;
		g: number;
		b: number;
	}

	interface Cell {
		alpha: number;
		score: number;
	}

	// Rampa de riesgo: verde (0) -> amarillo -> naranja -> rojo (1).
	const RAMP: Array<[number, Rgb]> = [
		[0, { r: 124, g: 252, b: 56 }],
		[0.3, { r: 232, g: 255, b: 0 }],
		[0.55, { r: 255, g: 204, b: 0 }],
		[0.72, { r: 255, g: 122, b: 0 }],
		[0.84, { r: 255, g: 52, b: 20 }],
		[1, { r: 255, g: 24, b: 40 }]
	];

	let {
		score,
		detector,
		enabled = true
	}: {
		score: number | null;
		detector: TrailDetector | null;
		enabled?: boolean;
	} = $props();

	let canvasEl: HTMLCanvasElement | null = null;
	let ctx: CanvasRenderingContext2D | null = null;
	let points: TrailPoint[] = [];
	let running = false;
	let rafId = 0;
	let reduced = false;
	let lastSeq = 0;
	// Offset para expresar `now()` en el mismo reloj que las muestras `t`
	// (performance.now() o epoch), sin importar cuál use el colector.
	let clockOffset: number | null = null;

	function now(): number {
		return clockOffset === null ? Date.now() : performance.now() - clockOffset;
	}

	function syncClock(samples: TrailSample[]): void {
		if (clockOffset !== null) return;
		let newest = -Infinity;
		for (const s of samples) {
			if (Number.isFinite(s.t) && s.t > newest) newest = s.t;
		}
		if (newest !== -Infinity) clockOffset = performance.now() - newest;
	}

	function mixScore(t: number): Rgb {
		const clamped = Math.min(1, Math.max(0, t));
		for (let i = 1; i < RAMP.length; i++) {
			const [stopB, colorB] = RAMP[i];
			const [stopA, colorA] = RAMP[i - 1];
			if (clamped <= stopB) {
				const k = (clamped - stopA) / (stopB - stopA);
				return {
					r: Math.round(colorA.r + (colorB.r - colorA.r) * k),
					g: Math.round(colorA.g + (colorB.g - colorA.g) * k),
					b: Math.round(colorA.b + (colorB.b - colorA.b) * k)
				};
			}
		}
		return RAMP[RAMP.length - 1][1];
	}

	// Única fuente del trazo: el colector de la librería. Cada frame se piden
	// solo las muestras nuevas (seq > lastSeq) y se descartan las no numéricas.
	function consumeSamples(): void {
		const d = detector;
		if (!d) return;
		let samples: TrailSample[];
		try {
			samples = d.getRecentPoints(lastSeq) ?? [];
		} catch {
			return;
		}
		if (samples.length === 0) return;

		// Score vigente en este instante: mientras sea null se usa el neutro 0.5.
		const sampleScore =
			typeof score === "number" && Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0.5;

		for (const s of samples) {
			// Avanzar lastSeq para todas las muestras, incluso las que se ignoran,
			// para no volver a procesarlas en el siguiente frame.
			if (Number.isFinite(s.seq) && s.seq > lastSeq) lastSeq = s.seq;
			if (!Number.isFinite(s.x) || !Number.isFinite(s.y) || !Number.isFinite(s.t)) continue;
			if (reduced) continue; // movimiento reducido: sin trazo, pero se consume el seq.
			points.push({
				x: s.x,
				y: s.y,
				t: s.t,
				gap: s.kind === 1 || s.kind === 2,
				score: sampleScore
			});
			if (points.length > MAX_POINTS) points.shift();
		}
		syncClock(samples);
	}

	// Con la estela apagada no se dibuja ni se guarda nada: solo se avanza
	// lastSeq para que el buffer no se acumule al volver a encenderla.
	function discardSamples(): void {
		const d = detector;
		if (!d) return;
		try {
			const samples = d.getRecentPoints(lastSeq) ?? [];
			for (const s of samples) {
				if (Number.isFinite(s.seq) && s.seq > lastSeq) lastSeq = s.seq;
			}
		} catch {
			// El colector puede no estar listo; se reintenta en el siguiente tick.
		}
	}

	function clearCanvas(): void {
		const c = ctx;
		const canvas = canvasEl;
		if (!c || !canvas) return;
		c.clearRect(0, 0, canvas.width, canvas.height);
	}

	function start(): void {
		if (running) return;
		running = true;
		loop();
	}

	function stop(): void {
		running = false;
		if (rafId !== 0) {
			cancelAnimationFrame(rafId);
			rafId = 0;
		}
	}

	function loop(): void {
		rafId = requestAnimationFrame(loop);
		consumeSamples();
		draw();
	}

	function draw(): void {
		const c = ctx;
		const canvas = canvasEl;
		if (!c || !canvas) return;
		const t = now();
		while (points.length > 1 && t - points[0].t > FADE_MS) points.shift();
		c.clearRect(0, 0, canvas.width, canvas.height);
		if (reduced || points.length < 2) return;

		const cells = new Map<string, Cell>();

		for (let i = 1; i < points.length; i++) {
			const a = points[i - 1];
			const b = points[i];
			// Enter/leave (kind 1/2) rompen el trazo: nunca se une un segmento
			// a través de ellos, en ningún sentido.
			if (a.gap || b.gap) continue;
			const alpha = Math.min(
				Math.max(0, (FADE_MS - (t - a.t)) / FADE_MS),
				Math.max(0, (FADE_MS - (t - b.t)) / FADE_MS)
			);
			if (alpha <= 0.03) continue;
			const ax = a.x / PIXEL;
			const ay = a.y / PIXEL;
			const bx = b.x / PIXEL;
			const by = b.y / PIXEL;
			const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
			for (let s = 0; s <= steps; s++) {
				const x = Math.round(ax + ((bx - ax) * s) / steps);
				const y = Math.round(ay + ((by - ay) * s) / steps);
				const key = `${x},${y}`;
				const prev = cells.get(key);
				if (!prev) cells.set(key, { alpha, score: b.score });
				else {
					// El punto más reciente manda en color; el alfa es el máximo.
					cells.set(key, {
						alpha: Math.max(prev.alpha, alpha),
						score: b.score
					});
				}
			}
		}

		for (const [key, cell] of cells) {
			const comma = key.indexOf(",");
			const x = Number(key.slice(0, comma));
			const y = Number(key.slice(comma + 1));
			const color = mixScore(cell.score);
			// Casi todo el trazo a plena opacidad (como en la referencia); solo la
			// cola se desvanece, así ningún color se mezcla con el fondo.
			c.globalAlpha = Math.min(1, cell.alpha * 3);
			c.fillStyle = `rgb(${color.r} ${color.g} ${color.b})`;
			c.fillRect(x, y, THICKNESS, THICKNESS);
		}

		// Punto de la cabeza: lo pone el cursor custom (CustomCursor), así no se
		// duplican marcadores y la punta queda visible sobre cualquier fondo.

		c.globalAlpha = 1;
	}

	function resizeCanvas(): void {
		if (!canvasEl) return;
		canvasEl.width = Math.max(1, Math.floor(canvasEl.clientWidth / PIXEL));
		canvasEl.height = Math.max(1, Math.floor(canvasEl.clientHeight / PIXEL));
		ctx = canvasEl.getContext("2d");
		if (ctx) ctx.imageSmoothingEnabled = false;
		points = [];
		draw();
	}

	function onVisibility(): void {
		if (document.hidden) stop();
		else start();
	}

	$effect(() => {
		const canvas = canvasEl;
		if (!canvas || !detector || !enabled) return;
		reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		resizeCanvas();
		window.addEventListener("resize", resizeCanvas);
		document.addEventListener("visibilitychange", onVisibility);
		start();
		return () => {
			window.removeEventListener("resize", resizeCanvas);
			document.removeEventListener("visibilitychange", onVisibility);
			stop();
			points = [];
			lastSeq = 0;
			clockOffset = null;
		};
	});

	// Apagada: se detiene el loop, se limpia el lienzo y se descarta por seq.
	$effect(() => {
		if (enabled || !detector || typeof window === "undefined") return;
		stop();
		points = [];
		clearCanvas();
		const id = setInterval(discardSamples, 250);
		return () => clearInterval(id);
	});

	// Un score nuevo repinta (los puntos ya guardan su score histórico).
	$effect(() => {
		score;
		if (!enabled) return;
		if (ctx) draw();
	});
</script>

<canvas class="trail-canvas" aria-label="Trayectoria del mouse" bind:this={canvasEl}></canvas>

<style>
	/* Overlay del mouse: passthrough por diseño, la trayectoria no bloquea clics. */
	.trail-canvas {
		position: absolute;
		inset: 0;
		z-index: 3;
		width: 100%;
		height: 100%;
		pointer-events: none;
		image-rendering: pixelated;
	}
</style>
