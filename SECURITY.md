# Modelo de amenazas y límites

Este documento acompaña a la Etapa 10 del roadmap. La librería corre **en el
navegador del cliente**: cualquiera con acceso a la página puede leer su código,
parchearlo o dejar de ejecutarlo. Por eso se diseña para que engañarla sea
**costoso**, no para que sea imposible.

## Qué se defiende

- **Coherencia entre señales:**mouse, teclado, clics y scroll deben contar historias
  compatibles; una combinación implausible se puntúa como riesgo.
- **Inyección y humanización falsa:** eventos no confiables, cadencias de fórmula,
  jitter uniforme y bucles cortos de delays se detectan con medidas numéricas.
- **Replay dentro de la sesión:** una trayectoria idéntica repetida se marca como
  riesgo. No se comparan sesiones distintas.
- **Fail-closed:** sin evidencia suficiente el veredicto es `measuring`. Nunca
  `human`. Si falla la comprobación de integridad, tampoco se otorga confianza.
- **Liveness:** la página puede observar si el detector sigue latiendo, sin que
  ese estado cambie el veredicto.

## Límites aceptados (no promesas)

1. Un agente que controla el navegador de verdad genera **eventos reales**; no hay
   una señal mágica que lo distinga solo por `isTrusted`.
2. Sin servidor **no se puede detectar la misma grabación en otra sesión** ni
   comparar dispositivos entre visitantes.
3. Si el usuario parchea o desactiva la librería, lo importante debe verificarse
   **en el servidor** de la web que la integra.
4. El código es público: no hay secretos ni ofuscación. Se priorizan medidas
   estadísticas y coherencia, no reglas fijas fáciles de esquivar.
5. Los perfiles simulados del laboratorio (`LAB_REPORT.md`) no son agentes reales;
   muestran qué detecta hoy la librería, no cuánto aguanta un adversario real.

## Privacidad

Cero red, cero almacenamiento persistente, cero cookies/fingerprinting. Nunca se
guarda qué tecla se pulsó ni el texto escrito: solo tiempos, posiciones y
categorías numéricas. Todo vive en memoria y se descarta al parar la librería.
