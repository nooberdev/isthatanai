/**
 * Configura el comportamiento de entrada de las secciones (una sola estrategia de
 * entrada en toda la web): su título entra una vez con una máscara de clip-path
 * (inset) y el resto de la sección aparece con un fundado corto.
 * IntersectionObserver es la alternativa automática cuando el navegador no
 * soporta `animation-timeline: scroll()`.
 */
export function setupSectionReveal(): () => void {
  if (typeof document === "undefined") return () => {};

  const titles = Array.from(document.querySelectorAll<HTMLElement>(".section-title"));
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.closest(".section")?.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    },
    { threshold: 0.2 },
  );

  for (const title of titles) observer.observe(title);
  return () => observer.disconnect();
}
