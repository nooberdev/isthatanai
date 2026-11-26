<script lang="ts">
	// Cursor propio, pixel art: cruz blanca con borde negro, visible sobre los
	// tres fondos y sobre el texto. Solo se activa con puntero fino (no táctil).
	let { enabled = true }: { enabled?: boolean } = $props();

	let visible = $state(false);
	let active = $state(false);
	let cursorEl = $state<HTMLDivElement | null>(null);

	$effect(() => {
		if (typeof window === "undefined" || typeof document === "undefined") return;
		if (!enabled || window.matchMedia("(pointer: coarse)").matches) {
			active = false;
			visible = false;
			document.documentElement.classList.remove("has-custom-cursor");
			return;
		}

		active = true;
		document.documentElement.classList.add("has-custom-cursor");

		// El movimiento es molto frecuente: se escribe directamente en el DOM
		// para no recalcular plantillas reactivas en cada evento. `visible` solo
		// cambia en la primera aparición y al salir/blur.
		let shown = false;
		const move = (e: PointerEvent) => {
			if (cursorEl) cursorEl.style.transform = `translate3d(${e.clientX}px, ${e.clientY}px, 0)`;
			if (!shown) {
				shown = true;
				visible = true;
			}
		};
		const leave = () => {
			shown = false;
			visible = false;
		};

		window.addEventListener("pointermove", move, { passive: true });
		document.addEventListener("mouseleave", leave);
		window.addEventListener("blur", leave);

		return () => {
			document.documentElement.classList.remove("has-custom-cursor");
			window.removeEventListener("pointermove", move);
			document.removeEventListener("mouseleave", leave);
			window.removeEventListener("blur", leave);
		};
	});
</script>

{#if active}
	<div
		bind:this={cursorEl}
		class="custom-cursor"
		class:is-visible={visible}
		style="transform: translate3d(0px, 0px, 0)"
		aria-hidden="true"
	>
		<svg viewBox="0 0 7 7" width="14" height="14" shape-rendering="crispEdges">
			<rect x="2" y="0" width="3" height="7" fill="#000" />
			<rect x="0" y="2" width="7" height="3" fill="#000" />
			<rect x="3" y="1" width="1" height="5" fill="#fff" />
			<rect x="1" y="3" width="5" height="1" fill="#fff" />
		</svg>
	</div>
{/if}

<style>
	.custom-cursor {
		position: fixed;
		top: 0;
		left: 0;
		z-index: 9999;
		width: 0;
		height: 0;
		pointer-events: none;
		opacity: 0;
		/* Se transforma en cada pointermove: capa propia, sin repintados. */
		will-change: transform;
	}

	.custom-cursor.is-visible {
		opacity: 1;
	}

	.custom-cursor svg {
		position: absolute;
		top: -7px;
		left: -7px;
		display: block;
		image-rendering: pixelated;
	}
</style>
