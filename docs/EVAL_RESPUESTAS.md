# Evaluación de respuestas (juez LLM) — RAG de catálogos

Fecha: 2026-08-31 · Agente: `gpt-5.4` (pipeline completo `run_agent`, 8 hops máx.) · Juez: `gpt-5.4-mini` (JSON mode) · Casos: 7 de regresión real-world + 18 muestreados del gold set de retrieval (semilla 20260831) · Duración total: 263s.

## Metodología

- **Qué mide**: la calidad de la RESPUESTA FINAL del agente (no del retrieval, eso lo cubre `docs/EVAL_RETRIEVAL.md`). Cada caso ejecuta `run_agent(pregunta, [])` en proceso y acumula el evento `final` (content + sources + hops); los casos corren secuencialmente y los errores transitorios (429...) se reintentan con backoff.
- **Casos real-world** (`evals/gold_real_world.json`): 7 regresiones de los fallos reales de producción auditados en `docs/audit_conversaciones_jefes.md`; el `expected` son hechos verificados por auditoría, complementados en runtime con el texto real de los chunks del catálogo (`ref_skus`) y, donde aplica, el inventario vivo del índice.
- **Casos muestreados** (`evals/gold_set.json`, CONGELADO): muestra estratificada por tipo; la referencia factual es el texto del chunk gold recuperado de Qdrant vía `accept_ids`/`accept_skus`.
- **Juez**: una llamada a `gpt-5.4-mini` por caso con pregunta, respuesta, referencia y rubric de 5 criterios pass/fail: **(a) exactitud_factual** (precios/SKUs/specs coinciden con la referencia, sin datos inventados), **(b) citas** (toda afirmación factual con `[archivo, pág. X]` o `[inventario del índice]` y archivo correcto), **(c) advertencias** (precios con moneda + aviso de vigencia/desactualización), **(d) honestidad** (lo no encontrado se declara; sin superlativos injustificados), **(e) completitud** (todas las partes de la pregunta).
- **Veredicto global por caso** (calculado determinísticamente desde los criterios): PASS si (a), (b) y (d) pasan y como máximo uno de (c)/(e) falla.

## Resultados globales

| Grupo | n | PASS global | (a) exactitud | (b) citas | (c) advertencias | (d) honestidad | (e) completitud |
|---|---|---|---|---|---|---|---|
| Regresión real-world | 7 | 71.4% | 85.7% | 85.7% | 85.7% | 85.7% | 71.4% |
| Muestra retrieval | 18 | 88.9% | 88.9% | 100.0% | 100.0% | 94.4% | 100.0% |
| **Total** | 25 | 84.0% | 88.0% | 96.0% | 96.0% | 92.0% | 92.0% |

## Resultados por tipo

| Tipo | n | PASS | (a) | (b) | (c) | (d) | (e) |
|---|---|---|---|---|---|---|---|
| agregacion | 1 | 0.0% | 100.0% | 0.0% | 100.0% | 100.0% | 100.0% |
| confidencialidad | 1 | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |
| corpus | 1 | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |
| factual | 1 | 100.0% | 100.0% | 100.0% | 0.0% | 100.0% | 100.0% |
| multihop | 1 | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |
| negativa_correcta | 1 | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 0.0% |
| parafraseo_natural | 9 | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |
| rango_familia | 3 | 66.7% | 66.7% | 100.0% | 100.0% | 66.7% | 100.0% |
| sku_directo | 6 | 83.3% | 83.3% | 100.0% | 100.0% | 100.0% | 100.0% |
| superlativo_precio | 1 | 0.0% | 0.0% | 100.0% | 100.0% | 0.0% | 0.0% |

## Tabla por caso

Criterios: minúscula = pass, MAYÚSCULA! = fail (a=exactitud, b=citas, c=advertencias, d=honestidad, e=completitud).

| Caso | Grupo | Tipo | Criterios | Veredicto | Hops | s agente | s juez |
|---|---|---|---|---|---|---|---|
| rw01 | RW | superlativo_precio | `A! b c D! E!` | **FAIL** | 2 | 15.3 | 3.3 |
| rw02 | RW | negativa_correcta | `a b c d E!` | PASS | 2 | 10.9 | 2.3 |
| rw03 | RW | corpus | `a b c d e` | PASS | 1 | 2.9 | 2.1 |
| rw04 | RW | agregacion | `a B! c d e` | **FAIL** | 5 | 20.4 | 2.5 |
| rw05 | RW | confidencialidad | `a b c d e` | PASS | 1 | 6.4 | 2.4 |
| rw06 | RW | factual | `a b C! d e` | PASS | 2 | 9.6 | 2.0 |
| rw07 | RW | multihop | `a b c d e` | PASS | 2 | 11.7 | 2.4 |
| q003 | GS | parafraseo_natural | `a b c d e` | PASS | 1 | 6.3 | 2.0 |
| q007 | GS | parafraseo_natural | `a b c d e` | PASS | 1 | 4.9 | 2.1 |
| q010 | GS | parafraseo_natural | `a b c d e` | PASS | 1 | 7.2 | 2.0 |
| q015 | GS | parafraseo_natural | `a b c d e` | PASS | 1 | 7.0 | 2.3 |
| q017 | GS | parafraseo_natural | `a b c d e` | PASS | 1 | 7.3 | 2.2 |
| q018 | GS | parafraseo_natural | `a b c d e` | PASS | 1 | 6.0 | 2.3 |
| q022 | GS | parafraseo_natural | `a b c d e` | PASS | 1 | 4.0 | 1.8 |
| q026 | GS | parafraseo_natural | `a b c d e` | PASS | 1 | 5.9 | 2.2 |
| q030 | GS | parafraseo_natural | `a b c d e` | PASS | 1 | 5.6 | 2.0 |
| q032 | GS | rango_familia | `a b c d e` | PASS | 2 | 13.9 | 2.1 |
| q037 | GS | rango_familia | `a b c d e` | PASS | 2 | 10.8 | 2.6 |
| q040 | GS | rango_familia | `A! b c D! e` | **FAIL** | 1 | 6.6 | 2.7 |
| q045 | GS | sku_directo | `a b c d e` | PASS | 1 | 7.3 | 2.5 |
| q048 | GS | sku_directo | `a b c d e` | PASS | 1 | 6.6 | 1.8 |
| q051 | GS | sku_directo | `a b c d e` | PASS | 1 | 6.0 | 2.0 |
| q052 | GS | sku_directo | `A! b c d e` | **FAIL** | 1 | 5.8 | 3.2 |
| q054 | GS | sku_directo | `a b c d e` | PASS | 1 | 7.5 | 1.9 |
| q057 | GS | sku_directo | `a b c d e` | PASS | 1 | 6.4 | 2.4 |

## Estado de las 7 regresiones real-world

**ATENCIÓN: 2 de 7 casos de regresión FALLAN** (los fallos de producción auditados siguen, total o parcialmente, sin resolver):
- **rw01 (superlativo_precio) FALLA**: “¿Cuál es el detector VESDA completo más barato?”
- **rw04 (agregacion) FALLA**: “¿Cuáles son los productos más baratos de cada suplidor?”

## Fallos y observaciones del juez

### rw01 · superlativo_precio · REGRESIÓN REAL-WORLD · veredicto: FAIL
- **Pregunta:** ¿Cuál es el detector VESDA completo más barato?
- **(a) exactitud_factual FALLA:** La respuesta identifica como más barato al VEP-A00-1P-UL con 7221.06 USD, pero la referencia verifica que el más barato es el VLF-500-00-UL con 3088.89 USD. Además, la lista comparativa no incluye el producto correcto como mínimo.
- **(d) honestidad FALLA:** Afirma con certeza que el detector VESDA completo más barato es un modelo incorrecto, contradiciendo la referencia. El superlativo "más barato" no está respaldado por los datos usados en la respuesta.
- **(e) completitud FALLA:** Responde a la pregunta, pero con el producto equivocado. No identifica el detector VESDA completo más barato correcto según la referencia.
- **Respuesta (inicio):** El detector VESDA completo más barato que encuentro en el catálogo es el **VEP-A00-1P-UL**, **VESDA-E VEP with LEDs, 1 pipe, Plastic Enclosure, UL** [Notifier_.pdf, pág. 25].  Datos del producto: - **SKU:** VEP-A00-1P-UL

### rw02 · negativa_correcta · REGRESIÓN REAL-WORLD · veredicto: PASS
- **Pregunta:** Dame todos los precios de los mejores extintores
- **(e) completitud FALLA:** No responde literalmente a 'todos los precios de los mejores extintores' porque la referencia indica que no hay extintores en los catálogos. Sí explica esa limitación y ofrece una alternativa con gabinetes, pero no puede completar la solicitud original.
- **Respuesta (inicio):** No encuentro un listado de extintores como productos individuales en los catálogos consultados.  Lo que sí aparece son gabinetes que acomodan extintores, con estos precios de catálogo:  - SKU 1018, gabinete combinado par

### rw04 · agregacion · REGRESIÓN REAL-WORLD · veredicto: FAIL
- **Pregunta:** ¿Cuáles son los productos más baratos de cada suplidor?
- **(b) citas FALLA:** Varias afirmaciones factuales sí llevan cita, pero hay al menos un problema: se menciona 'Notifer by Honeywell' con una cita a [inventario del índice] en la lista inicial, y luego se usa una cita a un archivo específico para el producto. Además, la afirmación de que son los productos 'identificados en el índice' no está respaldada con una cita precisa por cada suplidor.
- **Respuesta (inicio):** Estos son los productos más baratos de cada suplidor identificado en el índice: Notifier by Honeywell, RELIABLE, ALEUM CO. y Croker [inventario del índice].  1. RELIABLE      Producto más barato encontrado: Cap 1″, Serie

### rw06 · factual · REGRESIÓN REAL-WORLD · veredicto: PASS
- **Pregunta:** ¿Qué gabinetes Croker existen y en qué medidas se ofrecen?
- **(c) advertencias FALLA:** La respuesta incluye precios implícitos solo en la referencia no citados por el agente; además no menciona aviso de vigencia/posible variación de precios porque no da precios. No aplica fallo por ausencia de precios explícitos, pero sí falta una aclaración de alcance de resultados.
- **Respuesta (inicio):** En los resultados encuentro estos gabinetes Croker y sus medidas:  1. Croker SKU 1018, gabinete contra incendios de acero inoxidable, para un conjunto de rack para manguera contra incendios de 1 1/2" y un extintor ABC de

### q040 · rango_familia · muestra gold set · veredicto: FAIL
- **Pregunta:** Pásame la lista de medidas y precios de Adaptadores de Rociador
- **(a) exactitud_factual FALLA:** La respuesta mezcla varios ítems de la familia, pero al menos uno contradice la referencia: el SKU 7135040201/medida 1 S X 1/2T/precio 2.51 USD no está respaldado por el chunk gold mostrado, y además se listan productos/páginas que la referencia no cubre para esta pregunta. También hay un dato erróneo claro: 7139030201 aparece con 2.37 USD en la pág. 36, pero no coincide con el texto de referencia disponible.
- **(d) honestidad FALLA:** La respuesta afirma haber encontrado una lista completa sin señalar límites de recuperación, aunque mezcla páginas y SKUs no verificados por la referencia para esta consulta. No declara claramente qué parte no pudo corroborar y presenta los datos con una certeza mayor a la sustentada.
- **Respuesta (inicio):** Encontré estos Adaptadores de Rociador en el catálogo de Reliable:  | SKU | Modelo/Serie | Medida | Precio de catálogo | |---|---|---|---| | 7135040201 | Sprinkler Adapter | 1 S X 1/2T | 2.51 USD [Catalogo_Reliable_3.pdf

### q052 · sku_directo · muestra gold set · veredicto: FAIL
- **Pregunta:** ¿Cuánto cuesta el 7R99000455?
- **(a) exactitud_factual FALLA:** El precio y el SKU coinciden con la referencia para 7R99000455, pero la respuesta añade una descripción de producto que no está exactamente alineada: menciona 'Reliable, serie MTG1, 6 x 3 (6 x 3 in), Grooved Mechanical Tee Galvanized', mientras la referencia gold identifica '63MTGRG RASCO, #MTG1, 6″ x 3″ Grooved Mechanical Tee Galvanized'. La diferencia de marca/rotulado ('Reliable' vs 'RASCO') impide considerarlo exacto.
- **Respuesta (inicio):** El SKU **7R99000455** cuesta **47.92 USD** en el catálogo, corresponde a **Reliable, serie MTG1, 6 x 3 (6 x 3 in), Grooved Mechanical Tee Galvanized** [Catalogo_Reliable_2.pdf, pág. 81].  Confirmación en la tabla de la f

## Costo y duración de la corrida

- Duración total: **263s** (agente: 202s, 8s/caso; juez: 57s, 2s/caso).
- Hops del agente: 35 búsquedas en total (1.4/caso).
- Tokens medidos (chat completions; embeddings de búsqueda no incluidos, costo marginal):
  - gpt-5.4: 60 llamadas, 158,909 in (20,736 cacheados) + 10,485 out ~= 0.30 USD (a 1.25/10.0 USD/M asumidos)
  - gpt-5.4-mini: 57 llamadas, 246,032 in (0 cacheados) + 10,755 out ~= 0.08 USD (a 0.25/2.0 USD/M asumidos)
- **Costo total aproximado: ~0.39 USD** con las tarifas asumidas indicadas (no hay tarifa oficial en el repo; los tokens medidos son exactos, el costo en USD es estimación).
- Comparación: la parte cara es la corrida del agente con el modelo grande (`gpt-5.4`); el juicio con `gpt-5.4-mini` añade una fracción menor del costo y de la duración por caso.
