# DIFF — Excel originales (data/raw_xlsx) vs parseo PDF (data/raw)

Generado: 2026-08-29 por el script de verificación de la ruta de ingesta xlsx (`app/ingest/parse_xlsx.py` vs `app/ingest/parse.py`).

## Metodología

- Se parsean las dos fuentes con los parsers reales del pipeline y se cruzan los registros por número de fila (la 'Fila N' del PDF es la fila N del Excel).
- Comparación campo a campo contra la lista blanca de etiquetas de cada archivo, tras **normalizar whitespace** (espacios múltiples, saltos de línea de envoltura del PDF, tabs y NBSP → un espacio) — exactamente la misma normalización `\s+ → ' '` que aplica `chunk.py` antes de construir los textos embebidos.
- Una celda se compara si al menos una fuente la trae no vacía. 'solo xlsx' = el Excel aporta valor y el PDF no; 'solo PDF' = al revés.

## Resumen global

- Celdas comparadas: **39,716**
- Coincidencia exacta tras normalizar: **39,716 (100.000%)**
- Valores solo en xlsx: **0** | solo en PDF: **0** | con contenido distinto: **0**
- Registros: los mismos números de fila en ambas fuentes en los 6 archivos.

## Coincidencia por campo y archivo

### Catalogo_Aleum.pdf — 594 filas

| Campo | Comparadas | Iguales | % | Solo xlsx | Solo PDF | Distintas |
|---|---:|---:|---:|---:|---:|---:|
| Part Number | 594 | 594 | 100.00% | 0 | 0 | 0 |
| Picture | 584 | 584 | 100.00% | 0 | 0 | 0 |
| Manufacturer | 594 | 594 | 100.00% | 0 | 0 | 0 |
| Category | 594 | 594 | 100.00% | 0 | 0 | 0 |
| Categoria | 594 | 594 | 100.00% | 0 | 0 | 0 |
| Size | 592 | 592 | 100.00% | 0 | 0 | 0 |
| Dimensions | 0 | — | — | — | — | — |
| Weight (lbs) | 501 | 501 | 100.00% | 0 | 0 | 0 |
| Short Description | 594 | 594 | 100.00% | 0 | 0 | 0 |
| Descripcion Corta (Español) | 594 | 594 | 100.00% | 0 | 0 | 0 |
| Description | 585 | 585 | 100.00% | 0 | 0 | 0 |
| Descripción (Español) | 585 | 585 | 100.00% | 0 | 0 | 0 |
| Unit Price | 593 | 593 | 100.00% | 0 | 0 | 0 |
| Price Confirmation Date | 593 | 593 | 100.00% | 0 | 0 | 0 |

### Catalogo_Reliable_1.pdf — 396 filas

| Campo | Comparadas | Iguales | % | Solo xlsx | Solo PDF | Distintas |
|---|---:|---:|---:|---:|---:|---:|
| Part Number | 396 | 396 | 100.00% | 0 | 0 | 0 |
| Short Code | 396 | 396 | 100.00% | 0 | 0 | 0 |
| Size | 396 | 396 | 100.00% | 0 | 0 | 0 |
| Photo | 367 | 367 | 100.00% | 0 | 0 | 0 |
| Supplier | 396 | 396 | 100.00% | 0 | 0 | 0 |
| Category (English) | 396 | 396 | 100.00% | 0 | 0 | 0 |
| Categoria (Español) | 396 | 396 | 100.00% | 0 | 0 | 0 |
| Temp °F | 380 | 380 | 100.00% | 0 | 0 | 0 |
| Temp °C | 380 | 380 | 100.00% | 0 | 0 | 0 |
| Finish | 396 | 396 | 100.00% | 0 | 0 | 0 |
| Finish (Spanish) | 390 | 390 | 100.00% | 0 | 0 | 0 |
| Short Description | 396 | 396 | 100.00% | 0 | 0 | 0 |
| Descripción Corta | 396 | 396 | 100.00% | 0 | 0 | 0 |
| Description | 393 | 393 | 100.00% | 0 | 0 | 0 |
| Descripción | 393 | 393 | 100.00% | 0 | 0 | 0 |
| Bulletin | 391 | 391 | 100.00% | 0 | 0 | 0 |
| Net/Net (USD) | 396 | 396 | 100.00% | 0 | 0 | 0 |
| Price Effective Date | 392 | 392 | 100.00% | 0 | 0 | 0 |

### Catalogo_Reliable_2.pdf — 451 filas

| Campo | Comparadas | Iguales | % | Solo xlsx | Solo PDF | Distintas |
|---|---:|---:|---:|---:|---:|---:|
| Part Number | 451 | 451 | 100.00% | 0 | 0 | 0 |
| Short Code | 451 | 451 | 100.00% | 0 | 0 | 0 |
| Size | 429 | 429 | 100.00% | 0 | 0 | 0 |
| Photo 1 | 450 | 450 | 100.00% | 0 | 0 | 0 |
| Photo 2 | 38 | 38 | 100.00% | 0 | 0 | 0 |
| Supplier | 451 | 451 | 100.00% | 0 | 0 | 0 |
| Category (English) | 451 | 451 | 100.00% | 0 | 0 | 0 |
| Categoria (Español) | 451 | 451 | 100.00% | 0 | 0 | 0 |
| Finish | 451 | 451 | 100.00% | 0 | 0 | 0 |
| Finish (Spanish) | 451 | 451 | 100.00% | 0 | 0 | 0 |
| Short Description | 451 | 451 | 100.00% | 0 | 0 | 0 |
| Descripción Corta | 451 | 451 | 100.00% | 0 | 0 | 0 |
| Description | 451 | 451 | 100.00% | 0 | 0 | 0 |
| Descripción | 451 | 451 | 100.00% | 0 | 0 | 0 |
| Bulletin | 451 | 451 | 100.00% | 0 | 0 | 0 |
| Net/Net (USD) | 451 | 451 | 100.00% | 0 | 0 | 0 |
| Price Effective Date | 451 | 451 | 100.00% | 0 | 0 | 0 |

### Catalogo_Reliable_3.pdf — 187 filas

| Campo | Comparadas | Iguales | % | Solo xlsx | Solo PDF | Distintas |
|---|---:|---:|---:|---:|---:|---:|
| Part Number | 187 | 187 | 100.00% | 0 | 0 | 0 |
| Short Code | 187 | 187 | 100.00% | 0 | 0 | 0 |
| Size | 187 | 187 | 100.00% | 0 | 0 | 0 |
| Photo | 187 | 187 | 100.00% | 0 | 0 | 0 |
| Supplier | 187 | 187 | 100.00% | 0 | 0 | 0 |
| Category (English) | 187 | 187 | 100.00% | 0 | 0 | 0 |
| Categoria (Español) | 187 | 187 | 100.00% | 0 | 0 | 0 |
| Box Qty | 183 | 183 | 100.00% | 0 | 0 | 0 |
| Finish | 181 | 181 | 100.00% | 0 | 0 | 0 |
| Finish (Spanish) | 181 | 181 | 100.00% | 0 | 0 | 0 |
| Short Description | 187 | 187 | 100.00% | 0 | 0 | 0 |
| Descripción Corta | 187 | 187 | 100.00% | 0 | 0 | 0 |
| Description | 187 | 187 | 100.00% | 0 | 0 | 0 |
| Descripción | 187 | 187 | 100.00% | 0 | 0 | 0 |
| Bulletin | 186 | 186 | 100.00% | 0 | 0 | 0 |
| Net/Net (USD) | 187 | 187 | 100.00% | 0 | 0 | 0 |
| Price Effective Date | 187 | 187 | 100.00% | 0 | 0 | 0 |

### Catalogo_Croker__2.pdf — 15 filas

| Campo | Comparadas | Iguales | % | Solo xlsx | Solo PDF | Distintas |
|---|---:|---:|---:|---:|---:|---:|
| Part Number | 15 | 15 | 100.00% | 0 | 0 | 0 |
| Size | 10 | 10 | 100.00% | 0 | 0 | 0 |
| Picture | 15 | 15 | 100.00% | 0 | 0 | 0 |
| Manufacturer | 15 | 15 | 100.00% | 0 | 0 | 0 |
| Dimensions | 7 | 7 | 100.00% | 0 | 0 | 0 |
| Trim Style | 3 | 3 | 100.00% | 0 | 0 | 0 |
| Door & Frame Materials | 3 | 3 | 100.00% | 0 | 0 | 0 |
| Door Style | 3 | 3 | 100.00% | 0 | 0 | 0 |
| Door Glazing | 3 | 3 | 100.00% | 0 | 0 | 0 |
| Unit Cost | 15 | 15 | 100.00% | 0 | 0 | 0 |
| List Price | 12 | 12 | 100.00% | 0 | 0 | 0 |
| Effective | 15 | 15 | 100.00% | 0 | 0 | 0 |
| Weight (lbs) | 11 | 11 | 100.00% | 0 | 0 | 0 |
| Category | 15 | 15 | 100.00% | 0 | 0 | 0 |
| Categoria | 15 | 15 | 100.00% | 0 | 0 | 0 |
| Short Description | 15 | 15 | 100.00% | 0 | 0 | 0 |
| Descripción Corta | 15 | 15 | 100.00% | 0 | 0 | 0 |
| Description | 15 | 15 | 100.00% | 0 | 0 | 0 |
| Descripción | 15 | 15 | 100.00% | 0 | 0 | 0 |

### Notifier_.pdf — 1977 filas

| Campo | Comparadas | Iguales | % | Solo xlsx | Solo PDF | Distintas |
|---|---:|---:|---:|---:|---:|---:|
| Part Number | 1977 | 1977 | 100.00% | 0 | 0 | 0 |
| Size | 8 | 8 | 100.00% | 0 | 0 | 0 |
| Dimensions | 45 | 45 | 100.00% | 0 | 0 | 0 |
| Brand | 127 | 127 | 100.00% | 0 | 0 | 0 |
| Supplier | 130 | 130 | 100.00% | 0 | 0 | 0 |
| Category | 1933 | 1933 | 100.00% | 0 | 0 | 0 |
| Categoria | 1933 | 1933 | 100.00% | 0 | 0 | 0 |
| Picture | 126 | 126 | 100.00% | 0 | 0 | 0 |
| Short Description | 1971 | 1971 | 100.00% | 0 | 0 | 0 |
| Descripcion Corta | 1971 | 1971 | 100.00% | 0 | 0 | 0 |
| Description | 129 | 129 | 100.00% | 0 | 0 | 0 |
| Descripcion | 129 | 129 | 100.00% | 0 | 0 | 0 |
| PRECIO DE LISTA July 2026 | 1977 | 1977 | 100.00% | 0 | 0 | 0 |
| COSTO FIRETECH | 1977 | 1977 | 100.00% | 0 | 0 | 0 |
| Weight (lbs) | 30 | 30 | 100.00% | 0 | 0 | 0 |

## Discrepancias reales

**Ninguna.** Tras normalizar whitespace, el 100% de las celdas coincide entre el Excel original y lo parseado del PDF.

## ¿Qué aporta el Excel que el PDF no tenía?

Nada: no hay ninguna celda con valor en el Excel que el render PDF haya omitido. El PDF era un render completo (sin pérdida de campos) de estos 6 .xlsx.

- **Dimensions de Aleum**: 0 celdas con valor en cualquiera de las dos fuentes → sigue 100% vacía en el Excel; correcto descartarla.
- **Notifier 'Description'**: 129 filas con valor; 129 idénticas al PDF, 0 solo en Excel, 0 distintas.
- **Notifier 'Descripcion'**: 129 filas con valor; 129 idénticas al PDF, 0 solo en Excel, 0 distintas.

## Conclusión sobre la fidelidad del parser PDF

El parser PDF (`parse.py`) resultó **100% fiel al Excel original** tras normalizar whitespace: mismos registros, mismos campos y mismos valores en las 39,716 celdas comparadas de los 6 archivos, incluidos los precios de 13 decimales de Notifier, las fechas y los casos límite (CALL, Discontinued, la línea anómala de Croker Fila 9). La ruta xlsx elimina el riesgo *teórico* de parseo del render, no corrige ningún error observado; ambas rutas producen chunks idénticos.
