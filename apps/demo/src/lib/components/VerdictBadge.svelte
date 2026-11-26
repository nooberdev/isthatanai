<script lang="ts">
	/**
	 * Veredicto en miniatura para cuando el hero ya no está en pantalla.
	 * Bloque plano drenched: el color del estado es el relleno y la tinta
	 * siempre es negra. Recibe la etiqueta y el color ya resueltos en
	 * +page.svelte. Solo aparece mientras el usuario está en las secciones.
	 */
	interface Props {
		label: string;
		/** Se conserva por compatibilidad, pero el badge ya no muestra score. */
		score?: string | null;
		question?: boolean;
		color: string;
		visible?: boolean;
	}

	let { label, question = false, color, visible = false }: Props = $props();

	let word = $derived(question ? `${label}?` : label);
</script>

<div
	class="verdict-badge"
	class:is-visible={visible}
	style="--badge-color: {color}"
	aria-hidden="true"
>
	<span class="verdict-badge__word">{word}</span>
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
		/* Referencia: chip de ~200px con el texto arrancando a 20px del borde.
		   Se encoge en móviles muy estrechos para no desbordar. */
		min-width: min(200px, calc(100vw - 2rem));
		padding: 0.5rem 1.25rem;
		border: 0;
		border-radius: 6px;
		box-shadow: none;
		/* Estado drenched: el relleno lo manda todo, sin punto ni separador. */
		background: var(--badge-color);
		color: #000;
		font-family: "Inter Variable", sans-serif;
		font-size: 18px;
		font-weight: 800;
		letter-spacing: -0.01em;
		line-height: 1;
		text-transform: uppercase;
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
