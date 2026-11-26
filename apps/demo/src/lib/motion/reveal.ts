/**
 * Entrada de las secciones: la propia sección es la carta (superficie, borde,
 * radio y sombra en layout.css) y se activa con `.is-visible` cuando entra en
 * el viewport. El IntersectionObserver observa la SECCIÓN: ya no tiene clip-path
 * (recortaba a sus hijos y hacía que nunca se activara). No se toca el DOM.
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
