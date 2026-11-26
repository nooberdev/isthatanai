/**
 * Entrada de las secciones: la propia sección es la carta (superficie, borde,
 * radio y sombra en layout.css) y se activa con `.is-visible` cuando entra en
 * el viewport. El IntersectionObserver observa la SECCIÓN y no sus hijos: el
 * título ya no lleva clip-path, pero observar el bloque completo evita
 * depender de la geometría de recortes internos. No se toca el DOM: título y
 * cuerpo siguen siendo hijos directos de `.section`.
 */
export function setupSectionReveal(): () => void {
  if (typeof document === "undefined") return () => {};

  const sections = Array.from(document.querySelectorAll<HTMLElement>(".section"));
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    },
    { threshold: 0.2 },
  );

  for (const section of sections) observer.observe(section);
  return () => observer.disconnect();
}
