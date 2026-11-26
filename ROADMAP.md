# ROADMAP

## Dónde estamos

- ✅ **Esqueleto del proyecto**, listo y verificado.
- ✅ **Pantalla principal** con semáforo, estela y cursor ya aprobados visualmente.
- ✅ **Etapa 3 terminada:** la librería captura el mouse de verdad y la estela usa esos datos.
- ✅ **Detección preliminar calibrada** con una sesión real de trackpad y 4 agentes: trackpad humano → HUMANO, bot recto → AGENTE. Falta validación con más personas y dispositivos.
- ✅ **Etapa 4 terminada y calibrada:** 10 medidas reales, score 0–1, razones y sesgo a humano hasta evidencia sostenida.
- 🔄 **Etapa 5 parcial:** grabador local y extensión Firefox listos; demo pública pendiente.

## Etapas

### Etapa 3 — recolector real del mouse ✅

La librería escucha el puntero y guarda lo reciente en memoria, sin calcular nada.

- `pointermove` en fase de captura y pasivo, con `getCoalescedEvents()` cuando esté disponible.
- Muestras: `seq`, `x`, `y`, `t`, `kind`, `pointerType`, `trusted`. Solo números.
- Buffer circular de 2048 muestras, `maxAgeMs` 15000.
- API: `start()`, `stop()`, `getRecentPoints(sinceSeq?)`, `getStats()`.
- Veredicto fijo: `"measuring"`, `score: null`, `confidence: 0`, `reasons: []`.

**Listo cuando:** la estela de la demo se dibuja con datos que vienen de la librería y no de la página.

### Etapa 4 — medidas del mouse y primer juez ✅ calibrado

Las 8 o 10 medidas más importantes, del checklist MOUSE:

- Trayectoria: rectitud, curvatura, cambios de dirección, suavidad del giro, teletransporte, saltos grandes, eficiencia del camino, zigzag, simetría, repetición exacta, curvas matemáticas perfectas, direcciones favoritas, origen del movimiento, entradas por el borde, deriva.
- Velocidad y aceleración: promedio, máxima, perfil de campana, arranque, frenado, velocidad constante, jerk, variación, velocidad según distancia, velocidad imposible, micro-pausas, ritmo de eventos, resolución de tiempo.
- Temblor y detalles finos: micro-temblor, ruido de píxel, movimientos subpíxel, tipo de dispositivo, pasos enteros, estabilidad en reposo, deriva al soltar.
- Puntería: Ley de Fitts, sobrepaso, corrección fina, tiempos de apuntar y de clic, precisión y dispersión del clic, fallos corregidos, ruta hacia el objetivo, anticipación, hover.

Con eso sale un puntaje 0–1 (más alto = más probable IA) y razones en palabras. Motor: pesos configurables por señal, combinación inteligente, ventana deslizante, memoria corta, "aún no sé" con datos escasos, evidencia mínima, suavizado, detección de cambio de control y protección contra falsos positivos por accesibilidad.

**Listo cuando:** el semáforo y el color de la estela responden a ese puntaje real.

### Etapa 5 — demo pública y grabador ← grabador local y extensión Firefox listos; demo pública pendiente

Subir la demo a una dirección pública y activar el grabador de sesiones. Va pronto a propósito: así se puede empezar a juntar datos mientras se sigue programando.

- Modo grabación, exportar/importar sesiones como datos.

**Listo cuando:** tú, el Grok Bot y cualquiera con el link pueden dejar una sesión grabada.

### Etapa 6 — clics y scroll

- Clicks: puntería, duración, ráfagas, ritmo.
- Scroll: velocidad, ritmo, saltos, dirección, inercia.

### Etapa 7 — teclado

- Ritmo, pausas, errores y pegado de texto; comportamiento de escritura.
- **Bloqueante:** falta la decisión sobre las categorías de tecla (letra, número, espacio, borrar, etc.).
- Privacidad: nunca guardar qué teclas se presionan, solo tiempos; ignorar campos de contraseña.

### Etapa 8 — el laboratorio ⭐ la más importante

Sesiones de humanos reales (mouse, trackpad y celular) contra agentes (Grok Bot y otro), incluyendo "actúa lo más humano posible" y una sesión grabada y repetida.

- Panel de demo en vivo, visualizador del camino del mouse, simulador de bot, calibración con datos reales, pruebas automáticas con agentes reales.

**Listo cuando:** hay una tabla honesta de a quiénes detecta y a quiénes no.

### Etapa 9 — afinar

Ajustar pesos con esos datos, bajar falsos positivos y añadir el modo accesibilidad (personas sin mouse o con lector de pantalla). Sensibilidad: estricto, normal, relajado. Perfiles por dispositivo: compu, laptop, celular, tablet. Umbrales configurables.

### Etapa 10 — combinar señales y resistir trampas

Coherencia entre mouse, teclado y clics; detección de repeticiones y de "humanización falsa".

- Randomizar qué señales pesan más, comprobaciones sorpresa de coherencia, protección contra manipulación, detección de eventos inyectados, detección de replay, detección de ruido falso, comprobación de que el ruido sea humano y no números aleatorios, detección de ritmo generado por fórmula.
- **Fail-closed:** "sin veredicto" es "no verificado", jamás "humano". Un bloqueo de la librería no debe otorgar confianza.
- **Liveness:** señal periódica de "sigo viva" para que la página note si apagaron o parchearon el detector.
- **Repetición en la sesión:** una grabación humana reproducida delata trayectorias idénticas.
- **Coste, no secreto:** el código es público; las reglas fijas se esquivan, así que se priorizan formas estadísticas y coherencia entre señales. Sin ofuscación.
- **Límites aceptados:** un agente que controla el navegador de verdad genera eventos reales; sin servidor no se detecta la misma grabación en otra sesión; si el usuario parchea la librería, lo importante se verifica en el servidor de la web.

### Etapa 11 — API completa y empaquetado

- `start()`, `stop()`, `pause()`, `resume()`, `getVerdict()`, `onVerdict(callback)`, `onChange()` (solo humano↔IA), `onThreshold(valor, callback)`, `getReasons()`, `getScoreBreakdown()`, `reset()`, `configure(opciones)`, `attachTo(elemento)`, `enableSignals()` / `disableSignals()`.
- Modo global para toda la página, modo debug con registro en consola, etiqueta `<script>` plug-and-play, paquete npm, envoltorios opcionales para React/Vue/Svelte, evento personalizado `document.addEventListener('isthatanai', ...)`, inicio automático opcional.
- Meta de tamaño: unas pocas decenas de KB como máximo.

### Etapa 12 — lanzamiento

README, licencia, demo pública bonita y versión 0.1.

## La ruta corta (versión 0.1 útil)

Etapas 3, 4, 5, 6 y una versión mini de la 8. Con eso ya hay algo que detecta con mouse y clics y se puede enseñar. El teclado y las trampas pueden esperar a la 0.2.

## Metas propuestas (punto de partida, no promesas)

- Menos de 5% de humanos marcados como IA.
- Atrapar a un agente sin disimular en pocos segundos de uso.
- Medir y reportar con honestidad al agente que disimula, aunque no se atrape siempre.

## Decisiones pendientes

1. **Categorías de tecla** para la Etapa 7 (letra, número, espacio, borrar, etc.).
2. **Aceptación de las metas** propuestas arriba.

## Reglas que no cambian

- Cero red, cero almacenamiento persistente, cero cookies/fingerprinting; todo en memoria y se borra al cerrar la página.
- Importar la librería no toca `window`, `document` ni `navigator`.
- Los veredictos son una señal más, nunca una verdad absoluta: el código corre en el navegador y un bot con acceso a él puede engañarlo.
