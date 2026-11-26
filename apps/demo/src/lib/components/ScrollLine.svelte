<script lang="ts">
	/**
	 * Indicador de veredicto: una línea fija, completa y permanente en la
	 * parte inferior. Su longitud no depende del scroll: solo cambia el color.
	 * No muestra texto, punto ni borde.
	 */
	interface Props {
		/** Color ya resuelto en +page.svelte (estado o ámbar de duda). */
		color: string;
	}

	let { color }: Props = $props();
</script>

<div class="scroll-line" style="--line-color: {color}" aria-hidden="true"></div>

<style>
	.scroll-line {
		position: fixed;
		inset-inline: 0;
		bottom: 0;
		width: 100%;
		height: 3px;
		/* Por debajo del panel de desarrollo (60), los controles (70) y el
		   cursor propio (9999); por encima de las secciones y del hero. */
		z-index: 50;
		pointer-events: none;
	}

	.scroll-line::after {
		content: "";
		position: absolute;
		inset: 0;
		background: var(--line-color);
		transition: background-color 360ms var(--ease-out);
	}

	@media (prefers-reduced-motion: reduce) {
		.scroll-line::after {
			transition: none;
		}
	}

	/* En pantallas con muesca, por encima de la zona de gesto del sistema. */
	@supports (bottom: env(safe-area-inset-bottom)) {
		.scroll-line {
			bottom: env(safe-area-inset-bottom);
		}
	}
</style>
