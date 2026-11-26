# Extensión de Firefox para calibración

Graba el movimiento del puntero mientras usas páginas web normales. No calcula
detección: solo entrega datos etiquetados para alimentar la Etapa 8.

## Cargar

1. Abre `about:debugging` en Firefox.
2. "Este Firefox" → "Cargar un complemento temporal…".
3. Selecciona `tools/firefox-extension/manifest.json`.

La extensión se descarga temporalmente; al cerrar Firefox hay que volver a cargarla.

## Uso

1. Clic en el icono de la extensión.
2. "Grabar humano" para tu uso normal, o "Grabar bot" para una sesión de agente.
3. Usa las páginas web como siempre. El grabador sigue activo entre pestañas.
4. "Detener" y después "Exportar JSON". El archivo baja a tu carpeta de descargas.

El JSON contiene `{ version, label, startedAt, endedAt, durationMs, sampleCount, samples }`.
Cada muestra tiene `seq, x, y, t, kind, pointerType, trusted, tabId`. `kind` es
0 movimiento, 1 entrada al documento, 2 salida. No se guardan URLs ni texto.

## Privacidad

- Cero red: la extensión no envía nada a ningún servidor.
- Cero almacenamiento: ni `localStorage`, ni cookies, ni IndexedDB.
- Todo vive en memoria del background y se descarta al cerrar Firefox o al
  empezar una grabación nueva. Solo sale cuando tú pulsas "Exportar JSON".

## Límites

- No probada en un Firefox real desde este entorno; la sintaxis se revisó con
  Node, pero el cargado y los permisos hay que verificarlos en tu navegador.
- En pantallas táctiles el patrón es distinto: graba por separado y no mezcles
  móvil con trackpad al calibrar.
- Los eventos `pointerenter`/`pointerleave` se registran en `document` sin
  captura, para no contar cada cruce entre elementos hijos.
