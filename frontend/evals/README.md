# Evaluación del RAG de Proyecto Alzheimer

Este directorio contiene el contrato del benchmark. El archivo
`alzheimer.template.jsonl` es una plantilla, no un conjunto de verdad: hay que
copiarlo a `alzheimer.jsonl` y reemplazar los ejemplos con preguntas y fuentes
validadas por los investigadores. `alzheimer.jsonl` y `results/` no se
versionan si contienen información sensible (`results/` está ignorado por Git).

Cada línea JSON define un caso. Los casos factuales agrupan las fuentes en
`evidence`: cada grupo es una pieza indispensable y cualquiera de sus `sources`
puede demostrarla. Esto permite medir **cobertura del conjunto de evidencia**,
no solo si apareció algún documento relacionado. Los patrones son expresiones
regulares, sin distinguir mayúsculas.

Categorías mínimas recomendadas:

- 30 preguntas factuales de un solo documento;
- 30 comparaciones multi-hop entre estudios;
- 20 preguntas sobre tablas, cifras, cohortes y unidades;
- 10 casos con evidencia contradictoria;
- 10 casos de ausencia, donde el sistema debe abstenerse.

Una pregunta crítica falla si falta una sola evidencia requerida, una cita no
se puede resolver contra las fuentes emitidas, no se cubre un concepto de
búsqueda, aparece contenido prohibido, o el verificador dictaminó alguna
afirmación que su fragmento citado no sostiene. La fidelidad la mide el
verificador en runtime y el benchmark solo la lee (`min_faithfulness` por
caso, opcional). El gate de release exige cero fallos críticos; los promedios
nunca los ocultan.

La puntuación es determinista y vive en `convex/evaluacion/puntuar.ts`; el
runner que habla con el despliegue es `scripts/evaluar.ts`. Los patrones de
cita y de abstención son los de `convex/lib/citas.ts`, los mismos del
verificador de producción.

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
