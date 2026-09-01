# Evaluación de AGREGACIÓN (juez LLM) — RAG de catálogos

Fecha: 2026-09-01 · Agente: `gpt-5.4` (pipeline completo `run_agent`, 8 hops máx.) · Juez: `gpt-5.4-mini` (JSON mode) · Casos: 10 de la categoría AGREGACIÓN (`evals/gold_agregacion.json`) · Índice: 3573 chunks / 7 archivos / 4 suplidores / 15 marcas · Duración total: 98s.

## Metodología

- **Qué mide**: la calidad de la RESPUESTA FINAL del agente (no del retrieval, eso lo cubre `docs/EVAL_RETRIEVAL.md`). Cada caso ejecuta `run_agent(pregunta, [])` en proceso y acumula el evento `final` (content + sources + hops); los casos corren secuencialmente y los errores transitorios (429...) se reintentan con backoff.
- **Casos de agregación** (`evals/gold_agregacion.json`): preguntas de orden, conteo y agrupación, la familia que la tool general `consultar_catalogo` resuelve de forma exacta (`_execute_catalog_query` → `scan_by_price`/`group_values`). Seis son preguntas TEXTUALES del uso real (con sus faltas de ortografía) y cuatro son composicionales nuevas. **La verdad de referencia NO sale de los PDFs ni de un LLM**: se calculó en proceso con ese mismo motor exacto sobre el índice vivo y se congeló en el JSON (SKUs, precios, páginas y conteos reales), así que el juez compara la respuesta contra el resultado aritmético del catálogo, no contra una paráfrasis. Los hechos congelados **dependen del estado del índice**: si se reingesta, hay que recalcularlos con el motor.
- **Juez**: una llamada a `gpt-5.4-mini` por caso con pregunta, respuesta, referencia y rubric de 5 criterios pass/fail: **(a) exactitud_factual** (precios/SKUs/specs coinciden con la referencia, sin datos inventados), **(b) citas** (toda afirmación factual con `[archivo, pág. X]` o `[inventario del índice]` y archivo correcto), **(c) advertencias** (precios con moneda + aviso de vigencia/desactualización), **(d) honestidad** (lo no encontrado se declara; sin superlativos injustificados), **(e) completitud** (todas las partes de la pregunta).
- **Veredicto global por caso** (calculado determinísticamente desde los criterios): PASS si (a), (b) y (d) pasan y como máximo uno de (c)/(e) falla.

## Resultados globales

| Grupo | n | PASS global | (a) exactitud | (b) citas | (c) advertencias | (d) honestidad | (e) completitud |
|---|---|---|---|---|---|---|---|
| Agregación | 10 | 50.0% | 90.0% | 80.0% | 100.0% | 60.0% | 60.0% |

## Resultados por tipo

| Tipo | n | PASS | (a) | (b) | (c) | (d) | (e) |
|---|---|---|---|---|---|---|---|
| agregacion | 3 | 33.3% | 66.7% | 66.7% | 100.0% | 33.3% | 33.3% |
| corpus_conteo | 3 | 66.7% | 100.0% | 66.7% | 100.0% | 100.0% | 100.0% |
| filtro_rango | 1 | 0.0% | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% |
| superlativo_precio | 3 | 66.7% | 100.0% | 100.0% | 100.0% | 66.7% | 66.7% |

## Tabla por caso

Criterios: minúscula = pass, MAYÚSCULA! = fail (a=exactitud, b=citas, c=advertencias, d=honestidad, e=completitud).

| Caso | Origen | Tipo | Pregunta | Criterios | Veredicto | Hops | s agente | s juez |
|---|---|---|---|---|---|---|---|---|
| ag01 | uso real (fallo 2 veces en produccion) | agregacion | Dame los productos mas baratos por supplier | `a b c d e` | PASS | 1 | 5.4 | 2.7 |
| ag02 | uso real | corpus_conteo | Cuantos suplidores diferentes hay y cuantos catalogos? | `a b c d e` | PASS | 2 | 4.6 | 2.5 |
| ag03 | uso real (variante) | corpus_conteo | Cuantas marcas diferentes hay | `a B! c d e` | **FAIL** | 1 | 2.6 | 2.5 |
| ag04 | uso real | agregacion | de cada catalogo búscame los 5 productos mas baratos | `a b c D! E!` | **FAIL** | 1 | 16.2 | 3.4 |
| ag05 | uso real (verdad ya auditada; espeja rw01) | superlativo_precio | cual es el detector VESDA completo mas barato? | `a b c d e` | PASS | 1 | 8.4 | 2.5 |
| ag06 | uso real | superlativo_precio | cuales son los mejores precios de vesda | `a b c d e` | PASS | 1 | 5.9 | 2.9 |
| ag07 | nueva | superlativo_precio | cual es el producto mas caro de todo el catalogo? | `a b c D! E!` | **FAIL** | 1 | 2.0 | 3.1 |
| ag08 | nueva composicional | filtro_rango | que productos tiene ALEUM entre 50 y 200 dolares? ordenalos por precio | `a b c D! E!` | **FAIL** | 1 | 8.1 | 3.6 |
| ag09 | nueva composicional | agregacion | cual es el producto mas caro de cada archivo? | `A! B! c D! E!` | **FAIL** | 1 | 7.1 | 3.7 |
| ag10 | nueva | corpus_conteo | cuantos productos tiene cada suplidor? | `a b c d e` | PASS | 1 | 3.1 | 3.6 |

## Estado de las preguntas del uso real

De los 10 casos, **6 son preguntas textuales que los usuarios escribieron en producción** (varias fallaban) y 4 son composicionales nuevas que ninguna regla del pipeline programó explícitamente.

| Caso | Pregunta del uso real | Veredicto |
|---|---|---|
| ag01 | Dame los productos mas baratos por supplier | PASS |
| ag02 | Cuantos suplidores diferentes hay y cuantos catalogos? | PASS |
| ag03 | Cuantas marcas diferentes hay | **FAIL** |
| ag04 | de cada catalogo búscame los 5 productos mas baratos | **FAIL** |
| ag05 | cual es el detector VESDA completo mas barato? | PASS |
| ag06 | cuales son los mejores precios de vesda | PASS |

- Preguntas reales: **4/6 PASS** (fallan: ag03, ag04).
- Composicionales nuevas: **1/4 PASS** (fallan: ag07, ag08, ag09).

## Fallos y observaciones del juez

### ag03 · corpus_conteo · agregación · uso real (variante) · veredicto: FAIL
- **Pregunta:** Cuantas marcas diferentes hay
- **(b) citas FALLA:** La afirmación factual sobre el total sí lleva la cita [inventario del índice], pero el listado de marcas no incluye citas por elemento. Aun así, el punto crítico es que no todas las afirmaciones factuales están citadas con el formato exigido.
- **Respuesta (inicio):** Hay 15 marcas diferentes en el índice [inventario del índice].  Listado de marcas encontradas [inventario del índice]: 1. Reliable 2. Notifier 3. ALEUM CO. 4. VESDA 5. System Sensor 6. HyperSpike 7. Li-ion Tamer 8. RSG 9

### ag04 · agregacion · agregación · uso real · veredicto: FAIL
- **Pregunta:** de cada catalogo búscame los 5 productos mas baratos
- **(d) honestidad FALLA:** Declara explícitamente que un catálogo no devolvió productos, pero la referencia indica que el archivo Maritima_Internacional_Servicios_Rediseno.pdf sí debía recorrerse como uno de los 7 archivos. Además, no presenta todos los archivos del índice de forma completa, aunque sí evita inventar productos para Maritima.
- **(e) completitud FALLA:** No responde completamente a lo pedido porque omite explícitamente uno de los 7 catálogos del índice en términos de productos listados (Maritima se reporta como sin resultados) y, por tanto, no entrega los 5 productos más baratos de cada catálogo tal como se solicitó.
- **Respuesta (inicio):** Aquí tienes los 5 productos más baratos de cada catálogo que sí devolvió resultados, ordenados por precio ascendente por archivo. Si un catálogo no devolvió productos, lo indico explícitamente.  Importante: los precios s

### ag07 · superlativo_precio · agregación · nueva · veredicto: FAIL
- **Pregunta:** cual es el producto mas caro de todo el catalogo?
- **(d) honestidad FALLA:** Aunque identifica correctamente el máximo, lo presenta como único cuando la referencia indica que hay empate en el primer puesto con otro SKU. No refleja esa ambigüedad.
- **(e) completitud FALLA:** No responde completamente: la referencia indica que hay dos productos empatados como los más caros (90080A-801-04-L y 90080A-801-02-L), pero la respuesta solo da uno.
- **Respuesta (inicio):** El producto más caro que encuentro en todo el catálogo es:  1. HyperSpike MA-2 UL C1D2 3200W SPKR-GRY, SKU 90080A-801-04-L, precio de lista 89025.68 USD [Notifier_.pdf, pág. 81]  Advertencia: es un precio de catálogo y p

### ag08 · filtro_rango · agregación · nueva composicional · veredicto: FAIL
- **Pregunta:** que productos tiene ALEUM entre 50 y 200 dolares? ordenalos por precio
- **(d) honestidad FALLA:** La respuesta presenta los 20 resultados como "los primeros resultados" y además afirma que "ya vienen ordenados por precio real de catálogo", lo cual no es indebido; sin embargo, no indica explícitamente que hay 117 productos en total ni aclara que es solo una selección parcial de los más baratos, como exige la referencia.
- **(e) completitud FALLA:** La pregunta pide qué productos tiene ALEUM entre 50 y 200 dólares y ordenarlos por precio; la respuesta solo muestra 20 resultados y no declara de forma explícita que es una lista parcial ni el total disponible (117).
- **Respuesta (inicio):** Sí, encontré productos de ALEUM entre 50 y 200 USD, ordenados por precio ascendente. A continuación te muestro los primeros resultados que devolvió el catálogo, ya vienen ordenados por precio real de catálogo:  1. 8" Ada

### ag09 · agregacion · agregación · nueva composicional · veredicto: FAIL
- **Pregunta:** cual es el producto mas caro de cada archivo?
- **(a) exactitud_factual FALLA:** La respuesta acierta en varios máximos, pero falla al omitir completamente Maritima_Internacional_Servicios_Rediseno.pdf pese a que la referencia indica que debe declararse que no tiene productos con precio. Además, presenta el máximo de Catalogo_Croker__2.pdf como 1065.00 USD, que coincide, pero no cubre los 7 archivos esperados.
- **(b) citas FALLA:** No todas las afirmaciones factuales llevan cita: el aviso final sobre Maritima no tiene cita, y la lista no cubre con evidencia explícita el archivo Maritima ni justifica la ausencia de resultados. Las demás filas sí incluyen citas, pero la respuesta completa no está suficientemente citada para todas las afirmaciones.
- **(d) honestidad FALLA:** Afirma no encontrar resultados para Maritima, pero no declara correctamente que ese documento no tiene productos con precio, que es lo que exige la referencia. También usa una formulación de certeza general sin resolver esa excepción de forma completa.
- **(e) completitud FALLA:** No responde a todos los archivos: falta el máximo de Maritima_Internacional_Servicios_Rediseno.pdf, que debía explicarse explícitamente como inexistente/no aplicable. Por ello la respuesta es incompleta.
- **Respuesta (inicio):** El producto más caro de cada archivo, según el catálogo y ordenado por precio descendente por archivo, es:  - Notifier_.pdf: HyperSpike Speaker Arrays, SKU 90080A-801-04-L, "HYPERSPIKE MA-2 UL C1D2 3200W SPKR-GRY", preci

## Adjudicación manual de los 5 fallos

> Sección **añadida a mano** el 2026-09-01 tras revisar las 10 respuestas completas contra la
> verdad congelada. Todo lo anterior lo genera `evals/judge_answers.py --agregacion`; una
> re-corrida lo regenera y borra esta sección. El número reportado arriba (**50.0%**) es el que
> produce el juez y es el que cuenta como métrica; lo de abajo explica qué hay realmente detrás.

| Caso | Juez | Adjudicación manual | Evidencia |
|---|---|---|---|
| ag03 | FAIL (b) | **Falso positivo del juez** | La respuesta da las 15 marcas exactas del facet y cita `[inventario del índice]` dos veces, una en el total y otra encabezando el listado. El juez exige cita *por elemento* de una lista que ya viene citada en bloque. |
| ag04 | FAIL (d,e) | **Falso positivo del juez** | El juez afirma que "omite uno de los 7 catálogos". La respuesta **sí** cierra con una sección `## Maritima_Internacional_Servicios_Rediseno.pdf` → "No encuentro productos en los resultados para este archivo". Los 6 catálogos con productos traen sus 5 más baratos con SKU, precio y página, todos coincidentes con el motor. |
| ag07 | FAIL (d,e) | **Ding menor, no fallo** | Valor, SKU y página del máximo son exactos (89 025.68 USD, 90080A-801-04-L, pág. 81). El juez penaliza no declarar el empate con 90080A-801-02-L, pero el `expected` congelado dice literalmente que "dar cualquiera de los dos (o los dos) es correcto": el juez fue más estricto que su propia referencia. |
| ag08 | **FAIL REAL** | **Fallo genuino, con causa en el motor** | La respuesta lista 20 productos correctos y ordenados, pero los presenta como "los primeros resultados" sin decir que hay **117** en el rango. No es que el agente lo oculte: **no puede saberlo**. Ver abajo. |
| ag09 | FAIL (a,b,d,e) | **Falso positivo del juez** | El juez dice que "omite completamente Maritima". La respuesta lo trata explícitamente: "Sobre Maritima_Internacional_Servicios_Rediseno.pdf, no encuentro resultados en los catálogos para identificar el producto más caro". Los 6 máximos restantes coinciden uno a uno con el motor (89 025.68 / 7 733.41 / 696.18 / 305.11 / 67.83 / 1 065.00). |

**Pass rate del juez: 5/10 (50.0%). Pass rate tras adjudicación manual contra la verdad
congelada: 9/10**, con un único fallo genuino (ag08).

### El fallo genuino (ag08): el motor no devuelve el tamaño del conjunto

`scan_by_price` hace `scroll(..., limit=limite)` y devuelve **solo las filas pedidas**, nunca
cuántas cumplían el filtro. Cuando la pregunta es "qué productos tiene ALEUM entre 50 y 200
dólares", el modelo recibe 20 filas y no tiene forma de distinguir "son estos 20" de "son los
20 primeros de 117". Con eso, la honestidad que pide el criterio (d) es literalmente
inalcanzable por construcción: el agente hizo lo máximo que podía ("los primeros resultados
que devolvió el catálogo") y aun así no puede acotar la lista.

Arreglo natural, en el motor y no en el prompt (misma filosofía que el resto del rediseño):
que `_execute_catalog_query` añada un `client.count(count_filter=...)` con el MISMO filtro y
que el texto de la tool diga "mostrando N de M productos que cumplen el filtro". Con ese dato
el modelo puede cerrar la respuesta con "hay 117 en total, estos son los 20 más baratos", y
(d)/(e) pasan sin tocar el system prompt.

### Lo que la categoría sí demuestra

- **Las 6 preguntas del uso real dan hechos exactos.** ag01 (la que falló dos veces en
  producción) devuelve los 4 suplidores con su mínimo real; ag05 clava la regresión auditada de
  rw01 (VLF-500-00-UL, 3 088.89 USD, pág. 26, y no el VLI-880 ni el VEP-A00-1P-UL); ag06 lista
  precios VESDA reales en orden ascendente y **no** declara un "mejor precio" de detector
  completo equivocado, sino que ofrece buscarlos aparte.
- **Una sola llamada a la tool basta.** 11 hops para 10 casos (1.1/caso): las composiciones
  "ordenar + agrupar", "filtrar + rango + ordenar" y "conteo por grupo" se resuelven en un solo
  `consultar_catalogo`, que es exactamente lo que el rediseño buscaba.
- **Exactitud factual 90%** y **advertencias 100%**: los números que el agente afirma son los
  del catálogo. Lo que se le escapa es el **metadato del resultado** (empates, totales,
  cobertura), no el dato.

### Limitación conocida del juez

3 de los 5 FAIL son errores de lectura de `gpt-5.4-mini` sobre respuestas largas: en ag04 y
ag09 el juez afirma que falta un archivo que la respuesta trata de forma explícita en su último
párrafo. El patrón (fallar el cierre de una respuesta larga) sugiere que conviene, en la
próxima iteración, o bien un juez más grande para esta categoría, o bien pedirle que cite el
fragmento de la respuesta en que basa cada fallo. Esos 5 FAIL **no** se re-corrieron con la
referencia retocada a propósito: ajustar el gold después de ver los resultados invalidaría la
métrica.

## Costo y duración de la corrida

- Duración total: **98s** (agente: 63s, 6s/caso; juez: 30s, 3s/caso).
- Hops del agente: 11 búsquedas en total (1.1/caso).
- Tokens medidos (chat completions; embeddings de búsqueda no incluidos, costo marginal):
  - gpt-5.4: 21 llamadas, 41,271 in (0 cacheados) + 5,297 out ~= 0.10 USD (a 1.25/10.0 USD/M asumidos)
  - gpt-5.4-mini: 11 llamadas, 29,367 in (0 cacheados) + 3,063 out ~= 0.01 USD (a 0.25/2.0 USD/M asumidos)
- **Costo total aproximado: ~0.12 USD** con las tarifas asumidas indicadas (no hay tarifa oficial en el repo; los tokens medidos son exactos, el costo en USD es estimación).
- Comparación: la parte cara es la corrida del agente con el modelo grande (`gpt-5.4`); el juicio con `gpt-5.4-mini` añade una fracción menor del costo y de la duración por caso.
