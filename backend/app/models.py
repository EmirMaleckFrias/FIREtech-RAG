"""Tipos compartidos entre servicios. NO añadir lógica aquí."""
from __future__ import annotations

from pydantic import BaseModel, Field


class Chunk(BaseModel):
    """Fragmento indexado en Qdrant, con metadatos de documento opcionales."""

    id: str
    text: str
    source_file: str
    page: int
    project_id: str | None = None
    document_id: str | None = None
    section: str = ""
    language: str = ""
    document_type: str = ""
    source_pages: list[int] = Field(default_factory=list)
    metadata: dict = Field(default_factory=dict)
    # Qué es este fragmento dentro del documento: "text" (texto corrido) o
    # "table" (fila o bloque tabular). Sirve para que la fuente se titule por
    # lo que es y para filtrar tablas cuando estorban.
    chunk_type: str = "text"
    score: float = 0.0
    # Identidad de la obra, cuando el documento es un artículo. `citation` es
    # la referencia corta ("Allegri et al., 2023"); vacía significa que no se
    # pudo determinar, y entonces se cita por nombre de archivo.
    title: str = ""
    citation: str = ""
    doi: str = ""

    def fuente(self) -> str:
        """Cómo nombrar el documento en una cita: la referencia si la hay."""
        return self.citation or self.source_file

    def locator(self) -> str:
        """Cómo encontrar este fragmento dentro de su documento.

        No todo documento tiene páginas: un .docx las calcula el visor al
        renderizar y un .txt no tiene ninguna, así que decir "pág. 3" de un
        Word sería inventarse un número que nadie puede comprobar. Se cita lo
        que de verdad existe en cada formato: la página en un PDF, la fila en
        una tabla, y la sección o el número de fragmento en el resto.
        """
        if self.document_type == "pdf" and self.page:
            return f"pág. {self.page}"
        if self.chunk_type == "table":
            # En una hoja de cálculo cada chunk ES una fila; en Word es una
            # tabla entera, y llamarla fila engañaría a quien la busque.
            if self.document_type == "docx":
                return f"tabla {self.page}"
            return f"fila {self.page}"
        if self.section:
            return f"sección: {self.section}"
        return f"fragmento {self.page}"

    def cite(self) -> str:
        return f"[{self.fuente()}, {self.locator()}]"


class SearchFilters(BaseModel):
    """Filtros documentales. Todos opcionales y todos exactos sobre el payload.

    `project_id` y `document_id` son además la frontera de acceso: cuando el
    llamador los fija, la búsqueda no puede salirse de ahí.
    """

    project_id: str | None = None
    document_id: str | None = None
    document_type: str | None = None
    language: str | None = None


class SourceRef(BaseModel):
    """Fuente mostrada al usuario junto a la respuesta.

    Lleva lo justo para citar y para que el frontend titule cada fuente por lo
    que es: archivo, página, sección y tipo. Nunca incluir aquí nada que el
    usuario no deba ver.
    """

    source_file: str
    page: int
    project_id: str | None = None
    document_id: str | None = None
    section: str = ""
    language: str = ""
    document_type: str = ""
    source_pages: list[int] = Field(default_factory=list)
    snippet: str = ""
    score: float = 0.0
    chunk_type: str = "text"
    # Identidad de la obra y el localizador ya montado, para que el frontend
    # muestre la misma cita que usa el modelo y no la reconstruya a su manera.
    title: str = ""
    citation: str = ""
    doi: str = ""
    locator: str = ""
    # Trazabilidad del pipeline de evidencia: qué puntos del plan recuperaron
    # este fragmento ("extra" si lo trajo una búsqueda del modelo) y el grado
    # que le dio el calificador ("directa", "parcial" o vacío = sin calificar).
    plan_items: list[str] = Field(default_factory=list)
    grado: str = ""
