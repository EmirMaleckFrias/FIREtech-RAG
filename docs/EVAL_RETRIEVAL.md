# Evaluación de retrieval — RAG de catálogos

Fecha: 2026-08-29 · Gold set: 60 preguntas (generado 2026-08-29, semilla 20260829, parafraseo con `gpt-5.4-mini`) · Embeddings: `text-embedding-3-large` · Reranker: `gpt-5.4-mini` · top-30 retrieval → top-8 post-rerank.

Métricas: **hit@30** = algún chunk aceptable en `hybrid_search(q, sin filtros, 30)` (pre-rerank); **hit@8 / MRR@8** = sobre `_execute_search(q)` (pipeline completo del agente: fast-path de SKU + híbrida + rerank LLM). A/B del fast-path vía `SKU_FASTPATH`.

## Resultados globales

| Modo | n | hit@30 (pre-rerank) | hit@8 (pipeline) | MRR@8 | fallbacks rerank |
|---|---|---|---|---|---|
| fast-path ON | 60 | 100.0% | 96.7% | 0.942 | 0 |
| fast-path OFF | 60 | 100.0% | 96.7% | 0.942 | 0 |

## Desglose por tipo de pregunta

| Tipo | n | hit@30 | hit@8 ON | MRR@8 ON | hit@8 OFF | MRR@8 OFF |
|---|---|---|---|---|---|---|
| parafraseo_natural | 30 | 100.0% | 96.7% | 0.917 | 96.7% | 0.917 |
| rango_familia | 10 | 100.0% | 90.0% | 0.900 | 90.0% | 0.900 |
| sku_directo | 20 | 100.0% | 100.0% | 1.000 | 100.0% | 1.000 |

## Desglose por archivo fuente

| Archivo | n | hit@30 | hit@8 ON | MRR@8 ON | hit@8 OFF | MRR@8 OFF |
|---|---|---|---|---|---|---|
| Catalogo_Aleum.pdf | 14 | 100.0% | 100.0% | 0.964 | 100.0% | 0.964 |
| Catalogo_Croker__2.pdf | 4 | 100.0% | 100.0% | 1.000 | 100.0% | 1.000 |
| Catalogo_Reliable_1.pdf | 7 | 100.0% | 85.7% | 0.857 | 85.7% | 0.857 |
| Catalogo_Reliable_2.pdf | 10 | 100.0% | 90.0% | 0.900 | 90.0% | 0.900 |
| Catalogo_Reliable_3.pdf | 7 | 100.0% | 100.0% | 1.000 | 100.0% | 1.000 |
| Notifier_.pdf | 18 | 100.0% | 100.0% | 0.944 | 100.0% | 0.944 |

## Efecto del reranker (hit@8 vs hit@30)

**Fast-path ON:**
- Aciertos que el retrieval traía en el top-30 y el rerank/corte a 8 perdió: **2** → q009 (rank30=27), q036 (rank30=3)
- Aciertos que NO estaban en el top-30 híbrido y el pipeline igual acertó (rescatados por el fast-path): **0**

**Fast-path OFF:**
- Aciertos que el retrieval traía en el top-30 y el rerank/corte a 8 perdió: **2** → q009 (rank30=27), q036 (rank30=3)
- Aciertos que NO estaban en el top-30 híbrido y el pipeline igual acertó (rescatados por el fast-path): **0**

Preguntas donde ON y OFF difieren en hit@8: **0**

Aunque perdió 2 aciertos (ambos con gold ambiguo, ver abajo), el reranker fue **netamente positivo**: rescató a rank 1 casos que el retrieval traía hundidos — `q045` (ficha técnica del 1778-A: rank30=17 → rank8=1), `q001` (rank30=7 → rank8=2), `q024` (rank30=5 → rank8=2), `q054` (rank30=4 → rank8=1). MRR@8 (0.942) supera con claridad lo que daría cortar el top-30 crudo a 8 sin rerank.

**Sobre el A/B del fast-path:** las 60 preguntas dieron resultados idénticos pregunta a pregunta en ambos modos. Causa: BM25 ya resuelve el match exacto de SKU — en 19 de 20 `sku_directo` el chunk correcto estaba en el top-4 del híbrido (la excepción, `q045`, en rank 17, la rescató el reranker igual). El fast-path encontró el producto en los 16 casos elegibles pero nunca cambió el resultado final. Dato latente: 4 de los 20 SKUs muestreados son solo dígitos (`7R99000455`, `5030`, ...) y NO disparan el fast-path (la regex `_extract_sku_candidates` exige letra o guion); hoy los salva BM25, pero la "garantía" del fast-path no los cubre.

## Fallos concretos (modo fast-path ON)

### q009 · parafraseo_natural · Catalogo_Reliable_1.pdf p.49
- **Pregunta:** ¿Manejan el rociador colgante Reliable de 1/2" en bronce, K5.6?
- **Se esperaba:** Fire Sprinkler Head F1FR56P5B3N Pendent K5.6 (80) Threads 1/2" (15mm) 300psi RA2614 (SKU ref `BG171132S9`, Catalogo_Reliable_1.pdf p.49)
- **Salió (top-3):** [Catalogo_Reliable_1.pdf p.30] B2281132S9,F1FR56P3BN · [Catalogo_Reliable_1.pdf p.29] B2201132S9,F1FR56P2BN · [Catalogo_Reliable_1.pdf p.26] B2131132S9,F1FR56P0BN
- **Diagnóstico:** rank30=27, rank8=None, fastpath_tokens=['K5.6'], fastpath_found=False, OFF rank8=None
- **Hipótesis:** falso fallo por **gold ambiguo**, no error de retrieval. El catálogo tiene decenas de filas casi idénticas (serie F1FR56, pendent, K5.6, 1/2″) que solo difieren en presión/temperatura/acabado; la pregunta parafraseada no menciona "300 psi", así que los 8 resultados devueltos (F1FR56P0BN…F1FR56P5BN, todos rociadores colgantes Reliable K5.6 de 1/2″ en bronce) responden la pregunta igual de bien que la fila gold. El rerank prefirió variantes hermanas y el corte a 8 dejó fuera la fila exacta (rank 27). Lección para el agente: ante familias con variantes casi duplicadas conviene responder con la serie y pedir la especificación faltante (presión/temperatura), no con una fila única.

### q036 · rango_familia · Catalogo_Reliable_2.pdf p.42
- **Pregunta:** ¿En qué tamaños viene Codo de ° de Reliable?
- **Se esperaba:** 11.25° Elbow (SKU ref `7R99000129`, Catalogo_Reliable_2.pdf p.42)
- **Salió (top-3):** [Catalogo_Reliable_2.pdf p.39] 7R99000121,7R99000122 · [Catalogo_Reliable_2.pdf p.40] 7R99000124,25225R · [Catalogo_Reliable_2.pdf p.40] 7R99000123,2225R
- **Diagnóstico:** rank30=3, rank8=None, fastpath_tokens=[], fastpath_found=False, OFF rank8=None
- **Hipótesis:** **artefacto del generador del gold set**, no del retrieval. La plantilla limpió códigos del nombre de familia y la regex se comió el "11.25" de "Codo de 11.25°", dejando la pregunta sin sentido ("Codo de ° de Reliable"). Aun así el híbrido puso la familia correcta (11.25° Elbow, p.42) en rank 3; el reranker, sin el dato del ángulo, eligió razonablemente la familia hermana 22.5° Elbow. Con la pregunta bien formada esto sería hit@8=1.

**Lectura conjunta:** los 2 fallos de hit@8 son artefactos del gold set (pregunta subespecificada frente a variantes casi duplicadas, y pregunta mutilada por el generador). No se observó ningún fallo real de retrieval: hit@30 = 100% en los 60 casos.

## Conclusiones accionables

- **El retrieval híbrido está sano: hit@30 = 100% en los 60 casos** y los 2 fallos de hit@8 (96.7%) son artefactos del gold set, no del sistema. La métrica a vigilar en regresiones es MRR@8 (hoy 0.942).
- **El fast-path de SKU hoy no mueve la aguja (ON = OFF en las 60 preguntas): BM25 ya resuelve el match exacto.** No hay motivo para quitarlo (es barato y es la garantía ante fallos léxicos), pero sí uno para arreglar su hueco: los SKUs 100% numéricos (`7R99000455`, `5030`, series 7R/7M de Reliable, Croker) no disparan `_extract_sku_candidates`. Sugerencia: aceptar también tokens de solo dígitos de ≥6 caracteres (o validar contra el índice `skus`), manteniendo la exclusión de medidas tipo `11/2`.
- **El reranker aporta valor neto**: rescató a rank 1 consultas que el híbrido traía en rank 4–17 (p. ej. `q045`) y no perdió ningún acierto no-ambiguo. Mantenerlo.
- **El riesgo de producto real que destapó `q009` son las variantes casi duplicadas** (misma serie, distinta presión/temperatura/acabado): el top-8 puede llenarse de hermanas y omitir la fila pedida. Vale la pena que el agente (capa LLM) pida la especificación faltante o cite la familia completa; y considerar deduplicar por serie en el top-8 para ganar diversidad.
- **Higiene del harness**: corregir `_strip_codes` en `build_gold_set.py` para no comer números de medida/ángulo en nombres de familia (causa de `q036`) antes de regenerar un gold set futuro. El actual queda congelado como baseline (`backend/evals/gold_set.json`, semilla 20260829).
