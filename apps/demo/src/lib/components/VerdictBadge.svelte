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
		visible?: boolean;
	}

	let {
		label,
		score = null,
		question = false,
		color,
		visible = false
	}: Props = $props();

	let hasScore = $derived(score !== null && score !== "" && score !== "—");
</script>

<div
	class="verdict-badge"
	class:is-visible={visible}
	style="--badge-color: {color}"
	aria-hidden="true"
>
	<span class="verdict-badge__dot"></span>
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
		padding: 0.3125rem 0.5625rem;
		/* Superficie neutra: el estado lo da el punto, no el fondo. */
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--card);
		color: var(--foreground);
		font-family: "Inter Variable", sans-serif;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.06em;
		line-height: 1;
		text-transform: uppercase;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		/* Nace del hero: comparte su progreso de scroll, mismo eje, sin rebote. */
		opacity: 0;
		transform: translateY(-8px) scale(0.94);
		transition:
			opacity var(--dur-220) var(--ease-out),
			transform var(--dur-220) var(--ease-out);
	}

	.verdict-badge.is-visible {
		opacity: var(--hero-progress, 0);
		transform:
			translateY(calc(-8px + 8px * var(--hero-progress, 0)))
			scale(calc(0.94 + 0.06 * var(--hero-progress, 0)));
	}

	.verdict-badge__dot {
		flex: none;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--badge-color);
	}

	.verdict-badge__question,
	.verdict-badge__score {
		letter-spacing: 0;
	}

	/* La duda y el número son información secundaria, no otro foco de color. */
	.verdict-badge__question,
	.verdict-badge__score,
	.verdict-badge__sep {
		color: var(--muted-foreground);
	}

	.verdict-badge__question {
		font-weight: 500;
	}

	.verdict-badge__score {
		font-weight: 500;
	}

	.verdict-badge__sep {
		opacity: 0.6;
	}

	@media (prefers-reduced-motion: reduce) {
		.verdict-badge {
			transform: none;
			transition: opacity var(--dur-180) linear;
		}

		.verdict-badge.is-visible {
			opacity: 1;
			transform: none;
		}
	}
</style>
