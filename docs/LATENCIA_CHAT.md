# Latencia del chat

Las llamadas interactivas permiten solicitar `service_tier: priority` para los mismos
modelos OpenAI y añaden una clave de caché nativa derivada del prefijo estático
del prompt. No se alteran mensajes, herramientas, razonamiento, recuperación,
citas ni la barrera de revisión. No se cachean respuestas o dictámenes del
verificador, ni se amplía la retención del proveedor.

OCR e ingesta conservan su transporte: solo los llamadores que pasan el perfil
`chat` activan estas opciones. Los ajustes viven en `lib/latencia.ts`, separados
de los de ingesta.

La búsqueda léxica empieza mientras se genera el embedding. La fusión espera
los dos resultados y mantiene candidatos, orden, filtros y aislamiento por
propietario. No se acorta el presupuesto ni se cambia la política de fallos.

- `CHAT_SERVICE_TIER=priority`: pide prioridad, con recargo.
- `CHAT_SERVICE_TIER=default` (default): procesamiento estándar. El primer
  ensayo no mostró un beneficio consistente que justifique activar el recargo.
- `CHAT_PROMPT_CACHE_ENABLED=false`: deja de enviar la clave de enrutamiento;
  no desactiva la caché automática que el proveedor pueda aplicar.

El gateway puede servir una petición prioritaria como estándar. La telemetría
guarda `chat_service_tier_solicitado` y los contadores `chat_tier_priority`,
`chat_tier_default` o `chat_tier_no_reportado`, además de los tokens cacheados
ya existentes. La estimación local de coste **no incluye el recargo priority**;
el coste facturado debe consultarse en Vercel.

No se promete una reducción fija: comparar preguntas equivalentes, latencia
total y por componente, citas, cobertura, abstenciones y tier realmente servido.
El registro del verificador es una medida de atribución, no una garantía de
verdad científica. La caché solo ahorra procesamiento cuando coincide un prefijo
suficientemente largo; añadir la clave no garantiza un acierto.

Ensayo real del 7 de septiembre de 2026, sobre datos sintéticos y una cifra
incorrecta insertada a propósito (script `frontend/scripts/medir-latencia.ts`):

| Configuración | Tiempo de revisar/corregir/verificar | Resultado |
| --- | --- | --- |
| Estándar | 14,7 s | Cifra detectada y corregida; atribución 1,0 |
| Prioridad + clave de caché | 22,2 s | Cifra detectada y corregida; atribución 1,0 |
| Prioridad + clave de caché | 14,1 s | Cifra detectada y corregida; atribución 1,0 |
| Estándar | 19,0 s | Cifra detectada y corregida; atribución 1,0 |

El gateway confirmó el tier solicitado en las cuatro corridas. Esta muestra
pequeña mezcla variación del modelo y calentamiento de cachés; no demuestra
aceleración de prioridad ni mide el RAG de punta a punta. Por eso se deja
estándar por defecto y se evita prometer un porcentaje de mejora.

Referencias:
- https://vercel.com/docs/ai-gateway/models-and-providers/service-tiers
- https://developers.openai.com/api/docs/guides/prompt-caching
