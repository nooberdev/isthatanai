<script lang="ts">
	import { onMount } from "svelte";

	type Section = { id: string; label: string };

	const SECTIONS: Section[] = [
		{ id: "overview", label: "Overview" },
		{ id: "install", label: "Install" },
		{ id: "quick-start", label: "Quick start" },
		{ id: "configuration", label: "Configuration" },
		{ id: "signals", label: "Signals" },
		{ id: "calibration", label: "Calibration" },
		{ id: "privacy-security", label: "Privacy & security" },
		{ id: "api", label: "API reference" },
		{ id: "faq", label: "FAQ" }
	];

	// El cierre de etiqueta se compone para que el parser de Svelte no cierre
	// el bloque <script> dentro de un literal de código.
	const endTag = "</" + "script>";
	const CODE = {
		install: "bun add is-that-an-ai",
		esm: [
			'import { IsThatAnAI } from "is-that-an-ai";',
			"",
			'const detector = new IsThatAnAI({ device: "auto" });',
			"detector.onVerdict((v) => console.log(v.state, v.score));",
			"detector.start();"
		].join("\n"),
		iife: [
			'<script src="dist/index.iife.js"></' + "script>",
			"<script>",
			"  const detector = new IsThatAnAI.IsThatAnAI();",
			"  detector.start();",
			endTag
		].join("\n"),
		quick: [
			'import { IsThatAnAI } from "is-that-an-ai";',
			"",
			"const detector = new IsThatAnAI();",
			"const off = detector.onVerdict((verdict) => {",
			"  console.log(verdict.state, verdict.score, verdict.reasons);",
			"});",
			"",
			"detector.start();",
			"",
			"// When you are done:",
			"off();",
			"detector.stop();"
		].join("\n"),
		verdict: [
			"type Verdict = {",
			'  state: "measuring" | "human" | "ai";',
			"  score: number | null;",
			"  confidence: number;",
			"  doubt: number;",
			"  reasons: string[];",
			"};",
			"",
			"// Recorded human session:  score 0.038   (humanMax = 0.25)",
			"// Fixed 7 ms typing bot:   score 0.786   (aiMin = 0.55)"
		].join("\n"),
		configure: [
			"detector.configure({",
			'  sensitivity: "estricto",',
			'  locale: "fr",',
			"  advancedMeasures: true",
			"});"
		].join("\n"),
		calibrate: [
			"// `session` comes from this tab's recorder, in memory.",
			"const result = detector.recalibrateFromSession(session);",
			"console.log(result.applied, result.samples, result.adjustments);",
			"",
			"detector.resetCalibration(); // back to the validated baseline"
		].join("\n")
	};

	let active = $state<string>("overview");
	let copied = $state<Record<string, boolean>>({});
	let copyFailed = $state<Record<string, boolean>>({});
	let dark = $state(false);
	const copyTimers = new Map<string, ReturnType<typeof setTimeout>>();

	async function copyCode(key: string, code: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(code);
			copied[key] = true;
			copyFailed[key] = false;
		} catch {
			copied[key] = false;
			copyFailed[key] = true;
		}
		const previous = copyTimers.get(key);
		if (previous) clearTimeout(previous);
		copyTimers.set(
			key,
			setTimeout(() => {
				copied[key] = false;
				copyFailed[key] = false;
			}, 1600)
		);
	}

	function toggleTheme(): void {
		dark = !dark;
		document.documentElement.classList.toggle("dark", dark);
	}

	function updateActive(): void {
		if (typeof window === "undefined") return;
		// Sigue el encabezado que entra en el tercio superior: resalta la
		// sección que se está leyendo, no solo la que ya llegó al header.
		const offset =
			window.innerWidth <= 900
				? Math.min(240, window.innerHeight * 0.35)
				: Math.min(360, window.innerHeight * 0.35);
		let current = SECTIONS[0].id;
		for (const section of SECTIONS) {
			const element = document.getElementById(section.id);
			if (element && element.getBoundingClientRect().top <= offset) current = section.id;
		}
		active = current;
	}

	onMount(() => {
		dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
		document.documentElement.classList.toggle("dark", dark);

		let frame = 0;
		const onScroll = () => {
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				updateActive();
			});
		};
		updateActive();
		window.addEventListener("scroll", onScroll, { passive: true });
		window.addEventListener("resize", onScroll);

		return () => {
			document.documentElement.classList.remove("dark");
			window.removeEventListener("scroll", onScroll);
			window.removeEventListener("resize", onScroll);
			if (frame) cancelAnimationFrame(frame);
			for (const timer of copyTimers.values()) clearTimeout(timer);
			copyTimers.clear();
		};
	});
</script>

<svelte:head>
	<title>Documentation · is that an ai?</title>
	<meta
		name="description"
		content="Install, configure and understand is-that-an-ai: a client-side, numeric-only human vs AI detector."
	/>
</svelte:head>

{#snippet heading(id: string, text: string)}
	<h2 id={id} class="section-title">
		<span>{text}</span>
		<a class="anchor" href={"#" + id} aria-label={"Link to " + text}>
			<span class="material-symbols-rounded" aria-hidden="true">link</span>
		</a>
	</h2>
{/snippet}

{#snippet codeBlock(key: string, code: string, label: string)}
	<figure class="code">
		<div class="code__head">
			<span class="code__label">{label}</span>
			<button
				type="button"
				class="code__copy"
				aria-label={copied[key] ? "Copied" : "Copy code"}
				title={copied[key] ? "Copied" : "Copy code"}
				onclick={() => copyCode(key, code)}
			>
				<span class="material-symbols-rounded" aria-hidden="true"
					>{copied[key] ? "check" : "content_copy"}</span
				>
				<span>{copied[key] ? "Copied" : copyFailed[key] ? "Failed" : "Copy"}</span>
			</button>
		</div>
		<pre class="code__pre"><code>{code}</code></pre>
	</figure>
{/snippet}

<div class="docs-page">
	<header class="docs-header">
		<div class="docs-header__inner">
			<a class="brand" href="/" aria-label="is that an ai? — home">
				is that an ai<span class="brand__mark">?</span>
			</a>
			<span class="docs-header__sep" aria-hidden="true"></span>
			<span class="docs-header__current">Documentation</span>
			<div class="docs-header__actions">
				<button
					type="button"
					class="theme-button"
					aria-label={dark ? "Activate light theme" : "Activate dark theme"}
					title={dark ? "Activate light theme" : "Activate dark theme"}
					aria-pressed={dark}
					onclick={toggleTheme}
				>
					<span class="material-symbols-rounded" aria-hidden="true"
						>{dark ? "light_mode" : "dark_mode"}</span
					>
				</button>
				<a class="header-link" href="/">
					Back to demo
					<span class="material-symbols-rounded" aria-hidden="true">arrow_forward</span>
				</a>
			</div>
		</div>
	</header>

	<div class="docs-layout">
		<nav class="rail" aria-label="Documentation sections">
			<p class="rail__title">Contents</p>
			<ul class="rail__list">
				{#each SECTIONS as section (section.id)}
					<li>
						<a
							href={"#" + section.id}
							class:is-active={active === section.id}
							aria-current={active === section.id ? "location" : undefined}
						>
							{section.label}
						</a>
					</li>
				{/each}
			</ul>
			<p class="rail__foot">Runs in the browser. Nothing is sent or saved.</p>
		</nav>

		<main class="docs-main">
			<div class="page-intro">
				<h1>Documentation</h1>
				<p class="lede">
					A small library that reads how a person moves, clicks, scrolls and types — and returns a
					number. Everything stays on the page.
				</p>
			</div>

			<section class="doc-section" aria-labelledby="overview">
				{@render heading("overview", "Overview")}
				<p>
					is that an ai? is a dependency-free JavaScript library that estimates whether a person or
					an automated agent is controlling a web page. It observes the timing and shape of pointer,
					click, scroll and keyboard input, turns them into numbers, and returns a numeric verdict.
				</p>
				<p>
					Everything happens in the visitor's browser. There is no backend, no network request and no
					persistent storage: samples live in memory for the session and are discarded when the
					detector stops. The result is one signal to use alongside others — never the only gate for
					something important.
				</p>
				<aside class="note">
					<span class="material-symbols-rounded note__icon" aria-hidden="true">info</span>
					<p>
						<strong>Limit.</strong> The code is public and runs on the client. A dedicated attacker
						who controls the browser can still imitate a person; the goal is to make evasion costly
						and visible, not impossible.
					</p>
				</aside>
			</section>

			<section class="doc-section" aria-labelledby="install">
				{@render heading("install", "Install")}
				<p>Install the package with your package manager:</p>
				{@render codeBlock("install", CODE.install, "Shell")}
				<p>For a bundler or any ESM project:</p>
				{@render codeBlock("esm", CODE.esm, "TypeScript")}
				<p>
					For a plain page, load the minified IIFE build. It exposes a single global named
					<code>IsThatAnAI</code>; the class is <code>IsThatAnAI.IsThatAnAI</code>.
				</p>
				{@render codeBlock("iife", CODE.iife, "HTML")}
				<p>
					The package publishes ESM, the IIFE bundle and TypeScript declarations. Twelve locales ship
					as static dictionaries: <code>en</code>, <code>es</code>, <code>fr</code>,
					<code>de</code>, <code>pt</code>, <code>it</code>, <code>nl</code>, <code>sv</code>,
					<code>pl</code>, <code>ja</code>, <code>ko</code> and <code>zh</code>. English is the default
					and the fallback; the system language is detected at <code>start()</code>, never at import.
					Verdict reasons follow the active locale.
				</p>
			</section>

			<section class="doc-section" aria-labelledby="quick-start">
				{@render heading("quick-start", "Quick start")}
				<p>
					Create one detector, subscribe to verdicts, then start it when the DOM is ready. Both
					subscription methods return an unsubscribe function; <code>stop()</code> detaches the
					listeners and clears the session.
				</p>
				{@render codeBlock("quick", CODE.quick, "TypeScript")}
				<p>The verdict object has a fixed shape:</p>
				{@render codeBlock("verdict", CODE.verdict, "TypeScript")}
				<p>
					<code>score</code> runs from 0 (human-like) to 1 (agent-like) and is <code>null</code> when
					there is not enough evidence. A verdict becomes <code>human</code> at or below
					<code>0.25</code> and <code>ai</code> at or above <code>0.55</code>; between those bands the
					previous state is kept. <code>doubt</code> rises near a boundary, and <code>reasons</code>
					arrive in the active language.
				</p>
				<aside class="note">
					<span class="material-symbols-rounded note__icon" aria-hidden="true">info</span>
					<p>
						<strong>About the numbers.</strong> 0.038 is a recorded human typing session and 0.786 is
						a simulated 7 ms bot profile, measured with the same scorer. They are calibration
						points, not a promise about any particular visitor.
					</p>
				</aside>
			</section>

			<section class="doc-section" aria-labelledby="configuration">
				{@render heading("configuration", "Configuration")}
				<p>
					Options are normalized when the instance is created: caller objects are copied, and values
					that are missing, non-finite or out of range fall back to the default. Nothing is read from
					the DOM until <code>start()</code>.
				</p>
				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th scope="col">Option</th>
								<th scope="col">Default</th>
								<th scope="col">Effect</th>
							</tr>
						</thead>
						<tbody>
							<tr>
								<td><code>signals</code></td>
								<td>mouse, click, scroll, keyboard</td>
								<td>Signals allowed to contribute. Touch and attention are opt-in.</td>
							</tr>
							<tr>
								<td><code>device</code></td>
								<td><code>"auto"</code></td>
								<td><code>auto</code>, <code>desktop</code>, <code>touch</code> or <code>tv</code>. TV D-pad cadence is neutralized.</td>
							</tr>
							<tr>
								<td><code>detailedDevice</code></td>
								<td><code>"auto"</code></td>
								<td>Informative <code>computadora</code>, <code>laptop</code>, <code>celular</code>, <code>tablet</code>, <code>tv</code> or <code>touch</code>.</td>
							</tr>
							<tr>
								<td><code>sensitivity</code></td>
								<td><code>"normal"</code></td>
								<td><code>estricto</code>, <code>normal</code> or <code>relajado</code>: a threshold and confirmation preset.</td>
							</tr>
							<tr>
								<td><code>accessibility</code></td>
								<td><code>false</code></td>
								<td><code>false</code>, <code>true</code> or <code>"auto"</code>. Never treats a missing mouse as suspicious.</td>
							</tr>
							<tr>
								<td><code>antiCheat</code></td>
								<td><code>true</code></td>
								<td>Adds guardrail risk evidence without changing the calibrated score.</td>
							</tr>
							<tr>
								<td><code>antiCheatWeightJitter</code></td>
								<td><code>true</code></td>
								<td>Deterministic per-session weight jitter after 12 evaluations.</td>
							</tr>
							<tr>
								<td><code>advancedMeasures</code></td>
								<td><code>false</code></td>
								<td>Opt-in final measures with a bounded 0.15 share of the combined score.</td>
							</tr>
							<tr>
								<td><code>aggregatesOnly</code></td>
								<td><code>false</code></td>
								<td>Exposes only counts and rounded timing aggregates. DNT can force it on.</td>
							</tr>
							<tr>
								<td><code>locale</code></td>
								<td><code>"auto"</code></td>
								<td>One of the twelve locales, or system detection at <code>start()</code>.</td>
							</tr>
							<tr>
								<td><code>debug</code></td>
								<td><code>false</code></td>
								<td>Writes concise <code>console.debug</code> lines from each evaluation.</td>
							</tr>
							<tr>
								<td><code>customEvent</code></td>
								<td><code>false</code></td>
								<td>Dispatches <code>CustomEvent("isthatanai")</code> on <code>document</code> on state changes.</td>
							</tr>
							<tr>
								<td><code>mouse.bufferSize</code></td>
								<td><code>2048</code></td>
								<td>Ring-buffer capacity for pointer samples.</td>
							</tr>
							<tr>
								<td><code>mouse.maxAgeMs</code></td>
								<td><code>15000</code></td>
								<td>Maximum age of a pointer sample, in milliseconds.</td>
							</tr>
						</tbody>
					</table>
				</div>
				<p>Sensitivity changes classification only — never the raw measured score:</p>
				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th scope="col">Preset</th>
								<th scope="col">humanMax</th>
								<th scope="col">aiMin</th>
								<th scope="col">Confirm human</th>
								<th scope="col">Confirm AI</th>
							</tr>
						</thead>
						<tbody>
							<tr><td><code>estricto</code></td><td>0.20</td><td>0.45</td><td>150 ms</td><td>350 ms</td></tr>
							<tr><td><code>normal</code></td><td>0.25</td><td>0.55</td><td>250 ms</td><td>600 ms</td></tr>
							<tr><td><code>relajado</code></td><td>0.35</td><td>0.65</td><td>400 ms</td><td>900 ms</td></tr>
						</tbody>
					</table>
				</div>
				<p>Configuration can also be merged at runtime:</p>
				{@render codeBlock("configure", CODE.configure, "TypeScript")}
				<aside class="note">
					<span class="material-symbols-rounded note__icon" aria-hidden="true">info</span>
					<p>
						<strong>Fail closed.</strong> Explicit values in the same <code>configure()</code> call
						win over a preset. Inherited properties, non-finite numbers and overlapping bands are
						ignored, so a bad configuration cannot turn <code>measuring</code> into
						<code>human</code>.
					</p>
				</aside>
			</section>

			<section class="doc-section" aria-labelledby="signals">
				{@render heading("signals", "Signals")}
				<p>
					Each signal produces a value from 0 to 1, where 1 means more agent-like. A signal with too
					little evidence stays <code>null</code> and does not vote. Measures are statistical shapes,
					not fixed rules — a single “speed equals bot” check would be trivial to evade.
				</p>
				<dl class="deflist">
					<div>
						<dt class="dl-title">Mouse</dt>
						<dd class="dl-body">
							Path efficiency, turn smoothness, teleports and large jumps, speed uniformity, jerk,
							tremor, interval regularity, overshoot, micro-pauses and round steps. Limitation: an
							agent that imitates human tremor can look like a person when pointer data is the only
							evidence.
						</dd>
					</div>
					<div>
						<dt class="dl-title">Click</dt>
						<dd class="dl-body">
							Duration and interval regularity, burstiness, down/up drift, button usage, aim
							consistency and double-click rhythm. Limitation: a handful of clicks is weak evidence,
							so the score stays <code>null</code> until enough are observed.
						</dd>
					</div>
					<div>
						<dt class="dl-title">Scroll</dt>
						<dd class="dl-body">
							Delta uniformity, interval regularity, direction changes, deceleration, reading
							pauses, round deltas, axis lock and large jumps. Limitation: autoscroll is excluded
							before evidence is counted; programmatic scrolling may still look regular.
						</dd>
					</div>
					<div>
						<dt class="dl-title">Keyboard</dt>
						<dd class="dl-body">
							Inter-key timing, hold regularity, correction bursts, paste ratio, text without
							keydown, modifier shortcuts, pauses and exact rhythm. Limitation: key strings are
							discarded inside the listener, and a human typing verdict needs roughly 20 keydowns.
						</dd>
					</div>
					<div>
						<dt class="dl-title">Touch and attention</dt>
						<dd class="dl-body">
							Touch records pressure, contact area, orientation, timing and trust; attention observes
							visibility, focus, resize and idle transitions. Both collectors are off by default and
							carry no weight until <code>advancedMeasures: true</code>.
						</dd>
					</div>
					<div>
						<dt class="dl-title">Coherence and environment guardrails</dt>
						<dd class="dl-body">
							Cross-checks look for contradictions between channels, injected events, fake
							humanization, formula rhythms, repeated trajectories and surprising verdicts. Their
							output is additive risk evidence: it never lowers a clean score or sets a verdict by
							itself.
						</dd>
					</div>
				</dl>
			</section>

			<section class="doc-section" aria-labelledby="calibration">
				{@render heading("calibration", "Calibration")}
				<p>
					The human baseline comes from a recorded session: 45.44 WPM, 96.07% accuracy, keydown
					intervals centred around 189 ms, holds around 94 ms and natural pauses of one to eight
					seconds. That session scores 0.038 with the same scorer the browser uses.
				</p>
				<p>You can refine guardrail tolerances from a session recorded in this tab:</p>
				{@render codeBlock("calibrate", CODE.calibrate, "TypeScript")}
				<ul class="plain-list">
					<li>Adjustments are robust-median based and limited to ±20%.</li>
					<li>Absolute thresholds are clamped to safe ranges.</li>
					<li>Only guardrail tolerances change — never evidence gates or verdict thresholds.</li>
					<li>Calibration lives in memory for this session and is discarded on reset or stop.</li>
					<li>An empty or hostile session fails closed and leaves the current calibration unchanged.</li>
				</ul>
				<aside class="note">
					<span class="material-symbols-rounded note__icon" aria-hidden="true">info</span>
					<p>
						<strong>Calibration cannot force a verdict.</strong> With no evidence the verdict stays
						<code>measuring</code>, which means “not verified” — never “human”.
					</p>
				</aside>
			</section>

			<section class="doc-section" aria-labelledby="privacy-security">
				{@render heading("privacy-security", "Privacy & security")}
				<p>The privacy rules are enforced in code, not left to configuration:</p>
				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th scope="col">Rule</th>
								<th scope="col">Implementation</th>
							</tr>
						</thead>
						<tbody>
							<tr><td>No network</td><td>No fetch, XHR, WebSocket or beacons anywhere in the library.</td></tr>
							<tr><td>No persistence</td><td>No localStorage, sessionStorage, cookies or IndexedDB.</td></tr>
							<tr><td>No key identities</td><td>Key strings are read in the listener and discarded; only numeric categories are stored.</td></tr>
							<tr><td>No text</td><td>Only input-type metadata is used; typed data and clipboard contents are never read. Password fields are skipped.</td></tr>
							<tr><td>SSR safe</td><td>No window, document or navigator access at import or in the constructor. DOM access happens in <code>start()</code> and is cleaned up in <code>stop()</code>.</td></tr>
							<tr><td>Aggregates mode</td><td><code>aggregatesOnly: true</code>, or a Do Not Track signal, exposes counts and rounded timing only.</td></tr>
						</tbody>
					</table>
				</div>
				<p>
					Guardrails fail closed on missing evidence and on a failed integrity check. They look for
					untrusted injected events, formula rhythms, short humanization cycles, repeated paths inside
					the current session and contradictions between signals. <code>getLiveness()</code> and
					<code>onLiveness()</code> let the host page notice if the detector stops beating — liveness
					never changes a verdict.
				</p>
				<p>Accepted limits, described in the library's <strong>SECURITY.md</strong> threat model:</p>
				<ul class="plain-list">
					<li>An agent that truly controls the browser produces real events; <code>isTrusted</code> cannot tell it apart.</li>
					<li>Without a server, the same recording cannot be recognized across different sessions.</li>
					<li>If a visitor patches or disables the library, important actions must be verified server-side.</li>
					<li>The code is public: there are no secrets or obfuscation, only measures chosen to make evasion expensive.</li>
				</ul>
			</section>

			<section class="doc-section" aria-labelledby="api">
				{@render heading("api", "API reference")}
				<p>
					All methods live on the <code>IsThatAnAI</code> instance. Subscription methods return an
					unsubscribe function; getters return copies, so mutating a result cannot change the
					detector's state.
				</p>
				<h3 class="sub-title">Lifecycle</h3>
				<div class="table-wrap">
					<table>
						<thead>
							<tr><th scope="col">Method</th><th scope="col">Returns</th><th scope="col">What it does</th></tr>
						</thead>
						<tbody>
							<tr><td><code>start()</code></td><td><code>void</code></td><td>Attach collectors and begin the 100 ms evaluation loop. Idempotent.</td></tr>
							<tr><td><code>stop()</code></td><td><code>void</code></td><td>Stop the loop, detach, clear collectors and reset state.</td></tr>
							<tr><td><code>pause()</code> / <code>resume()</code></td><td><code>void</code></td><td>Freeze evaluation while keeping listeners attached.</td></tr>
							<tr><td><code>reset()</code></td><td><code>void</code></td><td>Clear buffers, scores, verdict, replay history and calibration.</td></tr>
							<tr><td><code>configure(config)</code></td><td><code>void</code></td><td>Merge runtime configuration safely.</td></tr>
							<tr><td><code>attachTo(target)</code></td><td><code>void</code></td><td>Bind collectors to a specific <code>EventTarget</code>.</td></tr>
						</tbody>
					</table>
				</div>
				<h3 class="sub-title">Verdicts and subscriptions</h3>
				<div class="table-wrap">
					<table>
						<thead>
							<tr><th scope="col">Method</th><th scope="col">Returns</th><th scope="col">What it does</th></tr>
						</thead>
						<tbody>
							<tr><td><code>getVerdict()</code></td><td><code>Verdict</code></td><td>Copy of the current verdict.</td></tr>
							<tr><td><code>onVerdict(cb)</code></td><td>unsubscribe</td><td>Called on every verdict update.</td></tr>
							<tr><td><code>onChange(cb)</code></td><td>unsubscribe</td><td>Only confirmed human ↔ AI changes; never <code>measuring</code>.</td></tr>
							<tr><td><code>onThreshold(value, cb)</code></td><td>unsubscribe</td><td>Score crossings of a value in <code>[0,1]</code>, in both directions.</td></tr>
						</tbody>
					</table>
				</div>
				<h3 class="sub-title">Scores and diagnostics</h3>
				<div class="table-wrap">
					<table>
						<thead>
							<tr><th scope="col">Method</th><th scope="col">Returns</th><th scope="col">What it does</th></tr>
						</thead>
						<tbody>
							<tr><td><code>getSignalScores()</code></td><td><code>SignalScores</code></td><td>Per-signal scores; <code>null</code> without enough evidence.</td></tr>
							<tr><td><code>getScoreBreakdown()</code></td><td><code>ScoreBreakdown</code></td><td>Weights, effective weights, EMA, handover, risk evidence and notes.</td></tr>
							<tr><td><code>getStats()</code></td><td><code>CollectorStats</code></td><td>Buffer fill, event rate, trust ratio and per-signal counts.</td></tr>
							<tr><td><code>getRecentPoints/Clicks/Scrolls/Keys/Inputs/Touches/Attention(sinceSeq?)</code></td><td>arrays</td><td>Numeric sample snapshots, filtered by sequence.</td></tr>
							<tr><td><code>getMouseFeatures()</code> / <code>getTouchFeatures()</code> / <code>getAttentionFeatures()</code></td><td>object or <code>null</code></td><td>Latest feature vectors from the last evaluation.</td></tr>
							<tr><td><code>getReasons()</code></td><td><code>string[]</code></td><td>Localized reasons for the current verdict.</td></tr>
						</tbody>
					</table>
				</div>
				<h3 class="sub-title">Device, guardrails and session</h3>
				<div class="table-wrap">
					<table>
						<thead>
							<tr><th scope="col">Method</th><th scope="col">Returns</th><th scope="col">What it does</th></tr>
						</thead>
						<tbody>
							<tr><td><code>getDeviceProfile()</code> / <code>getDetailedDevice()</code></td><td><code>string</code></td><td>Coarse profile and detailed device name.</td></tr>
							<tr><td><code>getSensitivity()</code> / <code>getAccessibility()</code> / <code>getPrivacyMode()</code></td><td><code>string</code> or <code>boolean</code></td><td>Effective modes in use.</td></tr>
							<tr><td><code>getLiveness(now?)</code> / <code>onLiveness(cb)</code></td><td>object / unsubscribe</td><td>Observational heart-beat; never changes the verdict.</td></tr>
							<tr><td><code>getIntegrity()</code></td><td><code>IntegrityReport</code></td><td>Runtime integrity check of weights, thresholds and clock.</td></tr>
							<tr><td><code>getReplaySignals()</code> / <code>getSurpriseCheck()</code></td><td>object</td><td>Guardrail observations for this session.</td></tr>
							<tr><td><code>getCalibration()</code> / <code>resetCalibration()</code></td><td>object or <code>null</code> / <code>void</code></td><td>Current bounded calibration and its reset.</td></tr>
							<tr><td><code>recalibrateFromSession(session)</code></td><td><code>CalibrationResult</code></td><td>Bounded, in-memory recalibration from a local session.</td></tr>
							<tr><td><code>enableSignals(list)</code> / <code>disableSignals(list)</code> / <code>getEnabledSignals()</code></td><td><code>void</code> / <code>Signal[]</code></td><td>Runtime signal filtering.</td></tr>
							<tr><td><code>setDebug(bool)</code> / <code>isDebug()</code></td><td><code>void</code> / <code>boolean</code></td><td>Console debug mode.</td></tr>
						</tbody>
					</table>
				</div>
				<h3 class="sub-title">Standalone helpers</h3>
				<p>
					The package also exports <code>autoStart()</code>, <code>installGlobal()</code>,
					<code>createReactDetector()</code>, <code>createSvelteDetector()</code>,
					<code>createVueDetector()</code>, <code>detectLocale()</code>, <code>t()</code>,
					<code>computeScore()</code>, <code>ScoreComputer</code> and pure guardrail helpers such as
					<code>evaluateCoherence()</code>, <code>detectReplay()</code>,
					<code>verifyIntegrity()</code> and <code>privacyAudit()</code>.
					<code>autoStart()</code> returns <code>null</code> on the server.
				</p>
			</section>

			<section class="doc-section" aria-labelledby="faq">
				{@render heading("faq", "FAQ")}
				<dl class="deflist">
					<div>
						<dt class="dl-title">Why measure behaviour at all?</dt>
						<dd class="dl-body">
							Because a credential or a checkbox says nothing about who is holding the mouse. The
							library adds a low-friction, privacy-preserving signal: how a session is driven, not
							what the visitor typed.
						</dd>
					</div>
					<div>
						<dt class="dl-title">Does it work on Android TV?</dt>
						<dd class="dl-body">
							Yes. D-pad, Enter and Escape navigation is recognized as a TV profile, and rhythm
							measures that would punish normal remote presses are neutralized. A sustained 60 ms
							arrow bot is still detected. It does not change third-party sites or their CAPTCHAs.
						</dd>
					</div>
					<div>
						<dt class="dl-title">Does it bypass a third-party CAPTCHA?</dt>
						<dd class="dl-body">
							No. Another site runs its own client and server checks. This library only produces
							verdicts in the page that integrates it.
						</dd>
					</div>
					<div>
						<dt class="dl-title">Why twelve languages?</dt>
						<dd class="dl-body">
							Because verdict reasons are user-facing. English is the default and the fallback;
							the other eleven dictionaries ship statically so no request is needed at runtime.
						</dd>
					</div>
					<div>
						<dt class="dl-title">How fast is the first verdict?</dt>
						<dd class="dl-body">
							About 800 ms with continuous pointer movement, about 700 ms for a regular typing bot,
							and about 3.7 s for a human typing session that first needs to accumulate 20 keydowns
							over three seconds. A verdict with too little evidence stays <code>measuring</code>.
						</dd>
					</div>
				</dl>
			</section>
		</main>
	</div>
</div>

<style>
	.docs-page {
		--docs-accent: color-mix(in srgb, var(--color-verdict-humano) 62%, var(--foreground));
		--docs-gutter: clamp(1.25rem, 4vw, 3rem);
		min-height: 100dvh;
		background: var(--background);
		color: var(--foreground);
		font-feature-settings: "cv11", "ss01";
	}

	:global(html:has(.docs-page)) {
		scroll-snap-type: none;
	}

	:where(a, button):focus-visible {
		outline: 2px solid var(--docs-accent);
		outline-offset: 2px;
	}

	.material-symbols-rounded {
		font-family: "Material Symbols Rounded Variable";
		font-weight: normal;
		font-style: normal;
		font-size: 18px;
		line-height: 1;
		letter-spacing: normal;
		text-transform: none;
		white-space: nowrap;
		word-wrap: normal;
		direction: ltr;
		font-feature-settings: "liga";
		-webkit-font-feature-settings: "liga";
		-webkit-font-smoothing: antialiased;
	}

	/* Header ---------------------------------------------------------------- */
	.docs-header {
		position: sticky;
		top: 0;
		z-index: 60;
		border-bottom: 1px solid var(--border);
		background: var(--background);
	}

	.docs-header__inner {
		display: flex;
		align-items: center;
		gap: 0.875rem;
		height: 3.75rem;
		max-width: 84rem;
		margin: 0 auto;
		padding-inline: var(--docs-gutter);
	}

	.brand {
		flex: none;
		color: var(--foreground);
		font-size: 0.9375rem;
		font-weight: 600;
		letter-spacing: -0.02em;
		text-decoration: none;
	}

	.brand__mark {
		color: var(--docs-accent);
	}

	.docs-header__sep {
		flex: none;
		width: 1px;
		height: 1rem;
		background: var(--border);
	}

	.docs-header__current {
		flex: none;
		color: var(--muted-foreground);
		font-size: 0.8125rem;
		font-weight: 500;
	}

	.docs-header__actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-left: auto;
	}

	.theme-button {
		display: grid;
		place-items: center;
		width: 30px;
		height: 30px;
		padding: 0;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: transparent;
		color: var(--muted-foreground);
		font-family: inherit;
		cursor: pointer;
		transition:
			color var(--dur-180) var(--ease-out),
			background-color var(--dur-180) var(--ease-out);
	}

	.theme-button:hover {
		background: color-mix(in srgb, var(--foreground) 7%, transparent);
		color: var(--foreground);
	}

	.header-link {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.375rem 0.5rem;
		border-radius: 6px;
		color: var(--muted-foreground);
		font-size: 0.8125rem;
		font-weight: 500;
		text-decoration: none;
		transition: color var(--dur-180) var(--ease-out);
	}

	.header-link:hover {
		color: var(--foreground);
	}

	.header-link .material-symbols-rounded {
		font-size: 16px;
	}

	/* Layout and rail ------------------------------------------------------- */
	.docs-layout {
		display: grid;
		grid-template-columns: 13.5rem minmax(0, 76ch);
		justify-content: center;
		gap: clamp(2.5rem, 5vw, 5rem);
		max-width: 84rem;
		margin: 0 auto;
		padding-inline: var(--docs-gutter);
	}

	.rail {
		position: sticky;
		top: 3.75rem;
		align-self: start;
		max-height: calc(100dvh - 3.75rem);
		overflow-y: auto;
		padding-block: 3.25rem 3rem;
	}

	.rail__title {
		margin: 0 0 0.875rem;
		padding-left: 0.75rem;
		color: var(--muted-foreground);
		font-size: 0.75rem;
		font-weight: 600;
	}

	.rail__list {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.rail__list a {
		position: relative;
		display: block;
		padding: 0.4375rem 0.75rem;
		border-radius: 6px;
		color: var(--muted-foreground);
		font-size: 0.8125rem;
		font-weight: 500;
		line-height: 1.4;
		text-decoration: none;
		transition:
			color var(--dur-180) var(--ease-out),
			background-color var(--dur-180) var(--ease-out);
	}

	.rail__list a:hover {
		background: color-mix(in srgb, var(--foreground) 6%, transparent);
		color: var(--foreground);
	}

	.rail__list a.is-active {
		background: color-mix(in srgb, var(--docs-accent) 10%, transparent);
		color: var(--docs-accent);
	}

	.rail__list a.is-active::before {
		content: "";
		position: absolute;
		top: 0.35rem;
		bottom: 0.35rem;
		left: 0;
		width: 2px;
		border-radius: 2px;
		background: var(--docs-accent);
	}

	.rail__foot {
		margin: 1.75rem 0 0;
		padding-left: 0.75rem;
		color: var(--muted-foreground);
		font-size: 0.75rem;
		line-height: 1.5;
	}

	/* Main column and type -------------------------------------------------- */
	.docs-main {
		min-width: 0;
		max-width: 76ch;
		padding-block: 3.25rem 7rem;
	}

	.page-intro {
		padding-bottom: 2.25rem;
		border-bottom: 1px solid var(--border);
	}

	h1 {
		margin: 0;
		font-size: clamp(2.125rem, 1.75rem + 1.6vw, 2.75rem);
		font-weight: 600;
		letter-spacing: -0.035em;
		line-height: 1.1;
		text-wrap: balance;
	}

	.lede {
		max-width: 68ch;
		margin: 1rem 0 0;
		color: var(--muted-foreground);
		font-size: 1.0625rem;
		line-height: 1.55;
	}

	.doc-section + .doc-section {
		margin-top: clamp(3rem, 6vw, 4.5rem);
		padding-top: clamp(2.25rem, 4vw, 3rem);
		border-top: 1px solid var(--border);
	}

	.section-title {
		display: flex;
		align-items: center;
		margin: 0 0 1.125rem;
		font-size: clamp(1.5rem, 1.3rem + 0.8vw, 1.875rem);
		font-weight: 600;
		letter-spacing: -0.025em;
		line-height: 1.25;
		scroll-margin-top: 5.5rem;
		text-wrap: balance;
	}

	.sub-title {
		margin: 2rem 0 0.75rem;
		font-size: 1rem;
		font-weight: 600;
		letter-spacing: -0.01em;
		line-height: 1.4;
	}

	.anchor {
		display: inline-flex;
		margin-left: 0.5rem;
		color: var(--muted-foreground);
		opacity: 0;
		transition: opacity var(--dur-180) var(--ease-out);
	}

	.section-title:hover .anchor,
	.anchor:focus-visible {
		opacity: 1;
	}

	.docs-main p,
	.docs-main li,
	.docs-main dd {
		max-width: 70ch;
		color: var(--muted-foreground);
		font-size: 0.9375rem;
		line-height: 1.7;
	}

	.docs-main p {
		margin: 0 0 1rem;
	}

	.docs-main p:last-child {
		margin-bottom: 0;
	}

	.docs-main strong {
		color: var(--foreground);
		font-weight: 600;
	}

	.plain-list {
		margin: 1rem 0 0;
		padding-left: 1.25rem;
	}

	.plain-list li + li {
		margin-top: 0.375rem;
	}

	:not(pre) > code {
		padding: 0.1em 0.35em;
		border: 1px solid var(--border);
		border-radius: 5px;
		background: color-mix(in srgb, var(--muted) 34%, transparent);
		color: var(--foreground);
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.86em;
		white-space: nowrap;
	}

	/* Code blocks ----------------------------------------------------------- */
	.code {
		margin: 1.25rem 0 1.5rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--muted) 26%, var(--background));
		overflow: hidden;
	}

	.code__head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.5rem 0.625rem 0.5rem 1rem;
		border-bottom: 1px solid var(--border);
	}

	.code__label {
		color: var(--muted-foreground);
		font-size: 0.75rem;
		font-weight: 500;
	}

	.code__copy {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.25rem 0.5rem;
		border: 1px solid transparent;
		border-radius: 6px;
		background: transparent;
		color: var(--muted-foreground);
		font-family: inherit;
		font-size: 0.75rem;
		line-height: 1;
		cursor: pointer;
		transition:
			color var(--dur-180) var(--ease-out),
			background-color var(--dur-180) var(--ease-out);
	}

	.code__copy:hover {
		background: color-mix(in srgb, var(--foreground) 8%, transparent);
		color: var(--foreground);
	}

	.code__copy .material-symbols-rounded {
		font-size: 15px;
	}

	.code__pre {
		margin: 0;
		padding: 1rem 1.125rem;
		overflow-x: auto;
	}

	.code__pre code {
		color: var(--foreground);
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.8125rem;
		line-height: 1.65;
		tab-size: 2;
	}

	/* Tables and lists ------------------------------------------------------ */
	.table-wrap {
		width: 100%;
		margin: 1.25rem 0 1.5rem;
		overflow-x: auto;
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.8125rem;
		font-variant-numeric: tabular-nums;
	}

	th,
	td {
		padding: 0.625rem 0.75rem;
		border-bottom: 1px solid var(--border);
		text-align: left;
		vertical-align: top;
		overflow-wrap: break-word;
	}

	th {
		background: color-mix(in srgb, var(--muted) 34%, transparent);
		color: var(--muted-foreground);
		font-size: 0.75rem;
		font-weight: 600;
		white-space: nowrap;
	}

	td {
		color: var(--muted-foreground);
		line-height: 1.6;
	}

	td:first-child {
		color: var(--foreground);
		font-weight: 500;
	}

	tbody tr:last-child td {
		border-bottom: 0;
	}

	.deflist {
		margin: 1.5rem 0 0;
		border-top: 1px solid var(--border);
	}

	.deflist > div {
		padding: 1.125rem 0;
		border-bottom: 1px solid var(--border);
	}

	.dl-title {
		margin: 0 0 0.375rem;
		color: var(--foreground);
		font-size: 0.9375rem;
		font-weight: 600;
		letter-spacing: -0.01em;
		line-height: 1.5;
	}

	.dl-body {
		margin: 0;
	}

	/* Quiet callout: one neutral 1px outline, no coloured left edge --------- */
	.note {
		display: flex;
		gap: 0.75rem;
		margin: 1.5rem 0 0;
		padding: 1rem 1.125rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--muted) 22%, var(--background));
	}

	.note__icon {
		flex: none;
		color: var(--docs-accent);
	}

	.note p {
		margin: 0;
		font-size: 0.875rem;
	}

	/* Narrow screens: the rail becomes a scrollable tab bar ----------------- */
	@media (max-width: 900px) {
		.docs-layout {
			display: block;
			padding-inline: 0;
		}

		.rail {
			top: 3.75rem;
			z-index: 50;
			max-height: none;
			margin-bottom: 0;
			padding: 0 var(--docs-gutter);
			border-bottom: 1px solid var(--border);
			background: var(--background);
		}

		.rail__title,
		.rail__foot {
			display: none;
		}

		.rail__list {
			flex-direction: row;
			gap: 0.25rem;
			overflow-x: auto;
			padding-block: 0.625rem;
			scrollbar-width: none;
		}

		.rail__list::-webkit-scrollbar {
			display: none;
		}

		.rail__list a {
			flex: none;
			padding: 0.375rem 0.625rem;
			border-radius: 999px;
			font-size: 0.8125rem;
			white-space: nowrap;
		}

		.rail__list a.is-active::before {
			display: none;
		}

		.docs-main {
			max-width: none;
			padding-inline: var(--docs-gutter);
			padding-top: 2.5rem;
		}

		.section-title {
			scroll-margin-top: 8.5rem;
		}
	}

	@media (max-width: 560px) {
		.docs-header__sep,
		.docs-header__current {
			display: none;
		}

		.docs-header__inner {
			gap: 0.5rem;
		}

		.header-link {
			font-size: 0;
			gap: 0;
			padding: 0.375rem;
		}

		.header-link .material-symbols-rounded {
			font-size: 18px;
		}

		.anchor {
			opacity: 1;
		}

		th,
		td {
			padding: 0.5625rem 0.625rem;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.rail__list a,
		.header-link,
		.theme-button,
		.code__copy,
		.anchor {
			transition: none;
		}
	}
</style>
