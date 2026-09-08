# Evaluación del RAG de Proyecto Alzheimer

Hay dos formas de evaluar el asistente, y las dos puntúan con la misma lógica
determinista (`convex/evaluacion/puntuar.ts`):

1. **La pestaña Calidad** (Ajustes > Calidad), para la usuaria: el asistente
   propone preguntas de control sobre SUS documentos, ella las revisa y una
   corrida periódica las responde con el agente real y las puntúa. Sin
   terminal, sin claves, sin ficheros. Es el camino normal.
2. **El benchmark desde la terminal** (`scripts/evaluar.ts` con un `.jsonl` de
   este directorio), para quien desarrolla: casos escritos a mano, reporte JSON
   con las corridas crudas, y un código de salida que sirve de gate.

## La pestaña Calidad

Todo lo de esta pestaña es por persona: cada cuenta tiene su corpus y, por
tanto, sus preguntas de control, sus generaciones y sus corridas
(`convex/evaluacion/datos.ts` acota cada lectura y escritura al propietario).

**Proponer preguntas** (`convex/evaluacion/generar.ts`). Un modelo lee
fragmentos reales del corpus (repartidos por documento y a lo largo de cada
uno, saltando bibliografía y agradecimientos) y propone casos en cinco
categorías, con reparto aproximado 40 / 25 / 15 / 10 / 10:

- *Un documento* (`single_hop`): una pregunta que se responde con un
  fragmento.
- *Varios documentos* (`multi_hop`): dos fragmentos de documentos distintos
  que comparten términos discriminantes; la pregunta exige combinar los dos.
- *Tabla o cifra* (`tabla`): filas o bloques de tabla; la pregunta pide una
  cifra concreta.
- *Debe decir que no está* (`abstencion`): algo plausible del mismo dominio
  que NO está en el corpus.
- *Trampa de otra entidad* (`entidad`): el corpus habla de Y; se pregunta por
  X, de la misma clase, para cazar al asistente que atribuye a X lo de Y.

El fichero y las páginas de la evidencia salen del fragmento, no del modelo. Las
cifras o términos que la respuesta debe contener (`answer_must_contain`) se
comprueban contra el texto del fragmento antes de aceptarse y se quedan solo con
lo que sobrevive a la traducción: el corpus suele estar en inglés y el asistente
responde en español, así que de "25.4 points" queda la cifra (que casa con
"25,4 puntos" y no con "125,4") y de "amyloid PET" no queda nada; las siglas y
los nombres con dígitos (MMSE, p-tau217) se escriben igual y valen, y una
palabra llana solo vale si el modelo la escribió también en la pregunta o en la
respuesta esperada en español. Los casos de ausencia y de entidad se comprueban
con la búsqueda léxica del corpus con los términos en español, en inglés y con
sus siglas (el índice está en el idioma de los artículos), y si la entidad
"ausente" devuelve fragmentos, el caso se descarta. Cada caso guardado pasa por
`validarCaso` y nace como *propuesto*, con la respuesta esperada en llano y una
clave estable (`single_hop-003`).

La generación va encadenada: una acción arma el plan (qué fragmentos, cuántas
preguntas por categoría) y cada `paso` hace UNA llamada al modelo y se reagenda,
porque una acción de Convex muere a los 600 s y una generación de 20 preguntas
son hasta 31 llamadas. Una llamada que no vuelve se corta a los 480 s; tres
fallos seguidos cierran la generación en error conservando lo ya propuesto. Cada
paso suma al menos 1 a `generados + descartados` (los fragmentos para los que el
modelo no propone nada cuentan como descartados): es el latido con el que
`datos.generacionColgada` distingue una generación viva de una muerta, sin tope
fijo de tiempo.

**Revisar**: la usuaria marca cada propuesta como correcta (aprobada) o la
descarta, y puede corregir la respuesta esperada. Solo las aprobadas entran en
las corridas.

**Evaluar** (`convex/evaluacion/correr.ts`). "Evaluar ahora" lanza una corrida
con las preguntas aprobadas (1 o 3 repeticiones); el cron
`evaluar la calidad` lanza una a la semana por cada cuenta con al menos 5
aprobadas y sin corrida en los últimos 6 días. Cada caso se responde en una
conversación OCULTA (no aparece en la barra lateral, no cuenta como pregunta de
la persona y se borra al puntuarla), un caso por acción para que ninguna corrida
muera por el tope de 10 minutos. Un turno que acaba en error puntúa como fallo
y la corrida sigue; solo un fallo de la maquinaria la marca `error`. El cron
`cerrar evaluaciones colgadas` cierra las que llevan en marcha más de lo que su
avance permite (`corridaColgada`: una hora como mínimo, y 15 minutos por turno
hecho o en marcha, contando las repeticiones); no hay tope fijo, así que una
corrida grande que avanza no se toca. "Evaluar ahora" aplica la misma regla y no
se queda bloqueado por una corrida muerta.

El historial guarda por corrida el resumen (`Resumen` de puntuar.ts) y por
pregunta la puntuación agregada de sus repeticiones y las respuestas recortadas,
para ver POR QUÉ falló sin conservar la conversación.

## Métricas

Las de siempre, con los nombres del evaluador Python para poder comparar
reportes: `evidence_recall`, `citation_precision`, `hops`,
`hop_pattern_coverage`, `answer_pattern_coverage`, `abstained`, `faithfulness`
(la mide el verificador en runtime; aquí solo se lee), `unsupported_claims`,
`unverified_claims`.

Y las de recuperación, que miden la BÚSQUEDA y no la respuesta. El agente anota
en `metrics.meta.recuperacion` los candidatos fusionados de cada punto del plan
(hasta 20, antes del calificador; los hops extra bajo `extra:<n>`), y con eso,
por cada evidencia esperada, `rank` es la posición del primer candidato que
casa con alguna fuente esperada, la mejor entre puntos:

- `retrieval_mrr`: media de 1/rank (0 la evidencia que no aparece).
- `retrieval_hit_at_5`, `retrieval_hit_at_20`: fracción de evidencias con
  rank <= 5 / <= 20.
- `context_precision`: fracción de las fuentes entregadas al modelo que casan
  con alguna evidencia esperada (1 en abstención o sin fuentes).
- `entity_misattributions`: afirmaciones que el verificador marcó como
  atribución a otra entidad (`entidad_distinta`).

Por cada evidencia, `failure_stage` dice dónde se perdió: `retrieval` (no
estaba entre los candidatos), `grading` (estaba y el calificador o la cuota la
dejaron fuera de las fuentes) o `generation` (llegó a las fuentes y la
respuesta no la citó; `cited` lo dice). El resumen agrega
`mean_retrieval_mrr`, `mean_retrieval_hit_at_5`, `mean_retrieval_hit_at_20`,
`mean_context_precision`, `entity_misattributions_total` y
`failures_by_stage`. Sin candidatos en la telemetría (mensajes anteriores a la
marca) las métricas de recuperación quedan `null` y no penalizan; un caso de
abstención no exige evidencias y también queda `null`.

## El benchmark desde la terminal

El archivo `alzheimer.template.jsonl` es una plantilla, no un conjunto de
verdad: hay que copiarlo a `alzheimer.jsonl` y reemplazar los ejemplos con
preguntas y fuentes validadas por los investigadores (o exportar las aprobadas
de la pestaña Calidad, que tienen el mismo formato en `definicion`).
`alzheimer.jsonl` y `results/` no se versionan: llevan preguntas y respuestas
sobre documentos clínicos (`.gitignore` de la raíz).

Cada línea JSON define un caso. Los casos factuales agrupan las fuentes en
`evidence`: cada grupo es una pieza indispensable y cualquiera de sus `sources`
puede demostrarla. Esto permite medir **cobertura del conjunto de evidencia**,
no solo si apareció algún documento relacionado. Los patrones son expresiones
regulares, sin distinguir mayúsculas.

Una pregunta crítica falla si falta una sola evidencia requerida, una cita no
se puede resolver contra las fuentes emitidas, no se cubre un concepto de
búsqueda, aparece contenido prohibido, o el verificador dictaminó alguna
afirmación que su fragmento citado no sostiene. El gate de release exige cero
fallos críticos; los promedios nunca los ocultan. Los patrones de cita y de
abstención son los de `convex/lib/citas.ts`, los mismos del verificador de
producción.

Validar el dataset sin hacer llamadas ni gastar nada:

```bash
cd frontend
npx vite-node scripts/evaluar.ts --dataset evals/alzheimer.jsonl --dry-run
```

Ejecutar contra el despliegue (lee `VITE_CONVEX_URL` y `CONVEX_DEPLOY_KEY` del
entorno o de `.env.local`). `--correo` es la cuenta CUYO CORPUS se pregunta;
las conversaciones que crea el benchmark se borran al terminar cada caso
(`--conservar` las deja para mirarlas en la interfaz):

```bash
npx vite-node scripts/evaluar.ts --dataset evals/alzheimer.jsonl \
  --correo medica@alzheimerproject.com --output evals/results/baseline.json --max-usd 2
```

Con repeticiones, para separar una mejora real del ruido (la misma pregunta
corrida 5 veces dio fidelidad entre 0.33 y 1.00):

```bash
npx vite-node scripts/evaluar.ts --dataset evals/alzheimer.jsonl \
  --correo medica@alzheimerproject.com --repeticiones 3
```

Los reportes contienen respuesta, fuentes, búsquedas, telemetría y fallos
exactos por corrida, más el agregado por caso (mediana de lo numérico, mayoría
de lo booleano y la dispersión) y el resumen con el gate. El código de salida
es 0 solo si el gate pasa y el benchmark se completó.
