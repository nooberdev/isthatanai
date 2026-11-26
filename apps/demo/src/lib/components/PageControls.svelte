<script lang="ts">
	import { onMount } from "svelte";
	import { resolve } from "$app/paths";
	import { tr } from "#lib/i18n";

	interface Props {
		trailEnabled: boolean;
		cursorEnabled: boolean;
		onReset: () => void;
	}

	let {
		trailEnabled = $bindable(true),
		cursorEnabled = $bindable(true),
		onReset
	}: Props = $props();

	let dark = $state(false);
	let open = $state(false);
	let rootEl: HTMLDivElement | null = null;
	let settingsBtn: HTMLButtonElement | null = null;

	// El tema vive solo en memoria: se inicializa desde el sistema, sin storage.
	onMount(() => {
		dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
		document.documentElement.classList.toggle("dark", dark);
		return () => {
			document.documentElement.classList.remove("dark");
		};
	});

	function toggleTheme(): void {
		dark = !dark;
		document.documentElement.classList.toggle("dark", dark);
	}

	// Sin backdrop: el popover es pequeño y el hero sigue recibiendo eventos.
	$effect(() => {
		if (!open || typeof document === "undefined") return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				open = false;
				settingsBtn?.focus();
			}
		};
		const onDown = (e: PointerEvent) => {
			const root = rootEl;
			if (root && e.target instanceof Node && !root.contains(e.target)) open = false;
		};
		document.addEventListener("keydown", onKey);
		document.addEventListener("pointerdown", onDown);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("pointerdown", onDown);
		};
	});

	function reset(): void {
		onReset();
		open = false;
	}
</script>

<div class="page-controls" bind:this={rootEl}>
	<div class="page-controls__bar" role="group" aria-label={tr("controls.group.aria")}>
		<a
			class="ctl"
			href={resolve('/docs')}
			aria-label="Documentation"
			title="Documentation"
		>
			<span class="material-symbols-rounded" aria-hidden="true">menu_book</span>
		</a>
		<span class="page-controls__divider" aria-hidden="true"></span>
		<button
			type="button"
			class="ctl"
			aria-label={dark ? tr("controls.theme.light") : tr("controls.theme.dark")}
			title={dark ? tr("controls.theme.light") : tr("controls.theme.dark")}
			aria-pressed={dark}
			onclick={toggleTheme}
		>
			{#if dark}
				<span class="material-symbols-rounded" aria-hidden="true">light_mode</span>
			{:else}
				<span class="material-symbols-rounded" aria-hidden="true">dark_mode</span>
			{/if}
		</button>
		<button
			type="button"
			class="ctl"
			bind:this={settingsBtn}
			aria-label={tr("controls.settings.aria")}
			title={tr("controls.settings.aria")}
			aria-expanded={open}
			onclick={() => (open = !open)}
		>
			<span class="material-symbols-rounded" aria-hidden="true">settings</span>
		</button>
	</div>

	{#if open}
		<div class="popover" role="dialog" aria-label={tr("controls.settings.aria")}>
			<p class="popover__title">{tr("controls.popover.title")}</p>
			<div class="popover__row">
				<span>{tr("controls.trail")}</span>
				<button
					type="button"
					role="switch"
					class="toggle"
					class:is-on={trailEnabled}
					aria-label={tr("controls.trail")}
					aria-checked={trailEnabled}
					onclick={() => (trailEnabled = !trailEnabled)}
				>
					<span class="toggle__knob" aria-hidden="true"></span>
				</button>
			</div>
			<div class="popover__row">
				<span>{tr("controls.cursor")}</span>
				<button
					type="button"
					role="switch"
					class="toggle"
					class:is-on={cursorEnabled}
					aria-label={tr("controls.cursor")}
					aria-checked={cursorEnabled}
					onclick={() => (cursorEnabled = !cursorEnabled)}
				>
					<span class="toggle__knob" aria-hidden="true"></span>
				</button>
			</div>
			<button type="button" class="popover__reset" onclick={reset}>{tr("controls.reset")}</button>
		</div>
	{/if}
</div>

<style>
	.page-controls {
		position: fixed;
		top: 0.25rem;
		right: 0.5rem;
		z-index: 70;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 0.375rem;
	}

	.page-controls__bar {
		display: flex;
		align-items: center;
		gap: 0.125rem;
		padding: 0.125rem;
		border: 1px solid color-mix(in srgb, var(--foreground) 10%, transparent);
		border-radius: 999px;
		background: color-mix(in srgb, var(--background) 74%, transparent);
		-webkit-backdrop-filter: blur(10px) saturate(140%);
		backdrop-filter: blur(10px) saturate(140%);
		box-shadow: 0 2px 10px rgb(0 0 0 / 8%);
	}

	.page-controls__divider {
		width: 1px;
		height: 16px;
		background: color-mix(in srgb, var(--foreground) 12%, transparent);
	}

	.ctl {
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		padding: 0;
		border: 0;
		border-radius: 999px;
		background: transparent;
		color: var(--foreground);
		font-family: inherit;
		text-decoration: none;
		cursor: pointer;
		transition: background-color var(--dur-180) var(--ease-out), transform var(--dur-180) var(--ease-out);
	}

	.ctl:hover {
		background: color-mix(in srgb, var(--foreground) 10%, transparent);
	}

	.ctl:active {
		transform: scale(0.94);
	}

	.ctl:focus-visible,
	.toggle:focus-visible,
	.popover__reset:focus-visible {
		outline: 2px solid var(--foreground);
		outline-offset: 2px;
	}

	.material-symbols-rounded {
		font-family: 'Material Symbols Rounded Variable';
		font-variation-settings: 'FILL' 1, 'wght' 600, 'GRAD' 0, 'opsz' 24;
		font-size: 18px;
		line-height: 1;
	}

	.popover {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
		width: 232px;
		padding: 0.875rem 1rem 1rem;
		border: 1px solid color-mix(in srgb, var(--foreground) 14%, transparent);
		border-radius: 14px;
		background: color-mix(in srgb, var(--background) 88%, transparent);
		-webkit-backdrop-filter: blur(14px) saturate(150%);
		backdrop-filter: blur(14px) saturate(150%);
		color: var(--foreground);
		box-shadow: 0 12px 32px rgb(0 0 0 / 16%), 0 2px 8px rgb(0 0 0 / 8%);
		font-family: var(--font-sans, "Inter Variable", sans-serif);
		font-feature-settings: "cv11", "ss01";
		font-size: 13px;
		font-weight: 500;
		line-height: 1.35;
		letter-spacing: -0.01em;
	}

	.popover__title {
		margin: 0;
		font-size: 13px;
		font-weight: 600;
		color: var(--foreground);
	}

	.popover__row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding-top: 0.5rem;
		border-top: 1px solid color-mix(in srgb, var(--foreground) 10%, transparent);
	}

	.toggle {
		position: relative;
		flex: none;
		width: 30px;
		height: 18px;
		padding: 0;
		border: 1px solid color-mix(in srgb, var(--foreground) 12%, transparent);
		border-radius: 999px;
		background: color-mix(in srgb, var(--muted) 70%, transparent);
		font-family: inherit;
		cursor: pointer;
		transition: background-color var(--dur-180) var(--ease-out), border-color var(--dur-180) var(--ease-out);
	}

	.toggle.is-on {
		border-color: transparent;
		background: var(--primary);
	}

	.toggle__knob {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 12px;
		height: 12px;
		border-radius: 999px;
		background: var(--foreground);
		transition: transform var(--dur-180) var(--ease-out), background-color var(--dur-180) var(--ease-out);
	}

	.toggle.is-on .toggle__knob {
		transform: translateX(12px);
		background: var(--primary-foreground);
	}

	.popover__reset {
		width: 100%;
		padding: 0.4rem 0.625rem;
		border: 1px solid color-mix(in srgb, var(--foreground) 10%, transparent);
		border-radius: 9px;
		background: color-mix(in srgb, var(--foreground) 4%, transparent);
		color: var(--foreground);
		font-family: inherit;
		font-size: 12px;
		font-weight: 500;
		letter-spacing: inherit;
		cursor: pointer;
		transition: background-color var(--dur-180) var(--ease-out);
	}

	.popover__reset:hover {
		background: color-mix(in srgb, var(--foreground) 10%, transparent);
	}

	@media (prefers-reduced-motion: reduce) {
		.ctl,
		.toggle,
		.toggle__knob,
		.popover__reset {
			transition: none;
		}
	}
</style>
