<script lang="ts">
	/**
	 * Veredicto en miniatura para cuando el hero ya no está en pantalla.
	 * No decide nada: recibe la etiqueta, el score y el color ya resueltos en
	 * +page.svelte. Solo aparece mientras el usuario está en las secciones.
	 */
	interface Props {
		label: string;
		score?: string | null;
		question?: boolean;
		color: string;
		ink: string;
		visible?: boolean;
	}

	let {
		label,
		score = null,
		question = false,
		color,
		ink,
		visible = false
	}: Props = $props();

	let hasScore = $derived(score !== null && score !== "" && score !== "—");
</script>

<div
	class="verdict-badge"
	class:is-visible={visible}
	style="--badge-color: {color}; --badge-ink: {ink}"
	aria-hidden="true"
>
	<span class="verdict-badge__word">{label}</span>
	{#if question}<span class="verdict-badge__question">?</span>{/if}
	{#if hasScore}
		<span class="verdict-badge__sep">·</span>
		<span class="verdict-badge__score">{score}</span>
	{/if}
</div>

<style>
	.verdict-badge {
		position: fixed;
		top: 1rem;
		left: 1rem;
		/* Por debajo de los controles (70) y del cursor propio (9999). */
		z-index: 60;
		pointer-events: none;
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.375rem 0.6875rem;
		border: 1px solid color-mix(in srgb, var(--badge-ink) 26%, transparent);
		border-radius: 999px;
		background: var(--badge-color);
		color: var(--badge-ink);
		font-family: "Inter Variable", sans-serif;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.06em;
		line-height: 1;
		text-transform: uppercase;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		opacity: 0;
		transform: translateY(-6px);
		transition:
			opacity var(--dur-220) var(--ease-out),
			transform var(--dur-220) var(--ease-out);
	}

	.verdict-badge.is-visible {
		opacity: 1;
		transform: translateY(0);
	}

	.verdict-badge__question,
	.verdict-badge__score {
		letter-spacing: 0;
	}

	.verdict-badge__sep {
		opacity: 0.72;
	}

	@media (prefers-reduced-motion: reduce) {
		.verdict-badge,
		.verdict-badge.is-visible {
			transform: none;
			transition: opacity var(--dur-180) linear;
		}
	}
</style>
