# Evaluación del RAG de Proyecto Alzheimer

Este directorio contiene el contrato del benchmark. El archivo
`alzheimer.template.jsonl` es una plantilla, no un conjunto de verdad: hay que
copiarlo a `alzheimer.jsonl` y reemplazar los ejemplos con preguntas y fuentes
validadas por los investigadores.

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
búsqueda o aparece contenido prohibido. El gate de release exige cero fallos
críticos; los promedios nunca los ocultan.

Validar el dataset sin hacer llamadas ni gastar dinero:

```bash
cd backend
.venv/bin/python evaluar.py --dataset evals/alzheimer.jsonl --dry-run
```

Ejecutar contra el backend local sin Supabase:

```bash
.venv/bin/python evaluar.py --dataset evals/alzheimer.jsonl \
  --output evals/results/baseline.json --max-usd 2.00
```

Con autenticación:

```bash
RAG_PASSWORD='...' .venv/bin/python evaluar.py \
  --dataset evals/alzheimer.jsonl --login investigador@airobotix.net \
  --output evals/results/baseline.json --max-usd 2.00
```

Los reportes contienen respuesta, fuentes, hops, telemetría y fallos exactos.
No deben versionarse si las preguntas o respuestas incluyen información
sensible; `evals/results/` está ignorado por Git.
