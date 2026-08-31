# Análisis de los 6 catálogos

> Resumen ejecutivo del análisis automatizado (detalle completo en
> [analisis_catalogos.json](analisis_catalogos.json) y
> [sintesis_esquema.json](sintesis_esquema.json)).

Los 6 PDFs comparten el mismo origen: **hojas de Excel renderizadas a PDF** (bloques
"■ Fila N" con pares `Etiqueta: valor`). No hay imágenes ni necesidad de OCR, pero los
registros **cruzan los saltos de página**, así que la ingesta segmenta por fila, nunca por página.

| Archivo | Proveedor / marcas | Contenido | Filas | Vigencia precios | Tipo de precio |
|---|---|---|---|---|---|
| Catalogo_Aleum.pdf | ALEUM CO. | Válvulas (mariposa, compuerta, check), coples, fittings ranurados, tees mecánicas, conectores flexibles | 594 | 2025-04-28 | Unitario (nivel único) |
| Catalogo_Reliable_1.pdf | Reliable (RASCO) | Rociadores (K-factor, temperaturas, acabados), rosetas, llaves | 396 | 2026-03-12 | Net/Net |
| Catalogo_Reliable_2.pdf | Reliable (RASCO) | Accesorios ranurados metálicos (coples, codos, tees, reducciones) | 451 | 2026-03-12 | Net/Net |
| Catalogo_Reliable_3.pdf | Reliable (RASCO) | CPVC, colgadores, consumibles (venta por caja) | 187 | 2026-03-12 | Net/Net |
| Catalogo_Croker__2.pdf | Croker + **AGF** (3 filas) | Gabinetes, mangueras, boquillas, TESTanDRAIN | 15 | **2023-07-15 (¡3 años!)** | Lista + costo interno |
| Notifier_.pdf | Notifier by Honeywell (10+ marcas: System Sensor, VESDA, Fire-Lite…) | Paneles FACP, detección, notificación, licencias | 1977 | 2026-07 | Lista + **COSTO FIRETECH (confidencial)** |

**Total: ~3,510 chunks de producto + ~86 resúmenes de familia.**

## Decisiones que salieron del análisis

1. **Chunk = 1 fila de producto** (registros autocontenidos de 150–900 tokens, overlap cero).
   Además, chunks `family_summary` por serie (tabla medida → SKU → precio) para preguntas
   de rango tipo "¿qué medidas hay de OS&Y ranurada?".
2. **Texto embebido bilingüe** (plantilla única): las consultas llegan en español sobre specs
   en inglés; marca+categoría+tipo encabezan el texto para anclar el matching.
3. **Confidencialidad**: `COSTO FIRETECH` (Notifier) y `Unit Cost` (Croker) son margen del
   distribuidor → payload con `visibility=internal`, **nunca** en el texto embebido ni en
   respuestas. La ingesta incluye un test automático que lo garantiza.
4. **`brand` ≠ archivo**: Croker contiene productos AGF y Notifier agrupa 10+ marcas
   Honeywell. La marca sale del campo Manufacturer o se infiere con flag `brand_inferred`.
5. **Precios**: `price_net_usd` (Aleum, Reliable) vs `price_list_usd` (Croker, Notifier) —
   nunca se comparan sin etiquetar; moneda **USD presunta** (ningún archivo la declara);
   toda respuesta cita la vigencia; `price_status` para los `CALL` (3), `Discontinued` (34)
   y sin precio (1).
6. **Datos sucios manejados con flags** (`data_quality_flags`): SKUs duplicados
   contradictorios en Aleum (ALGMT-8250/8300/8400 — se conservan ambas variantes y el
   agente pide confirmar medida), 102 SKUs repetidos en Notifier (se fusionan a la fila más
   completa), typos del origen ("Sprinler", "Superviory"), tamaños `2′` por `2″`.

## Recomendación principal al negocio — ✅ RESUELTA

Estos PDFs son renders de archivos Excel. Se consiguieron los **6 .xlsx originales**
(`data/raw_xlsx/`) y la ingesta ahora los usa como fuente por defecto (`ingest.py
--source xlsx`, auto-detectado), conservando las páginas del PDF para las citas.

**Auditoría de fidelidad** ([DIFF_XLSX_VS_PDF.md](DIFF_XLSX_VS_PDF.md)): 39,716 celdas
comparadas campo a campo entre Excel y PDF → **100.000% de coincidencia exacta**; los
3,569 chunks finales de ambas rutas son byte-idénticos. El parser PDF era una conversión
sin pérdida — el índice actual en Qdrant ya equivale a la fuente Excel.
