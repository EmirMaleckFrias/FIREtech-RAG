"""Tipos compartidos entre servicios. NO añadir lógica aquí."""
from __future__ import annotations

from pydantic import BaseModel, Field


class Chunk(BaseModel):
    """Un chunk indexado en Qdrant (payload + score de búsqueda)."""

    id: str
    text: str
    source_file: str
    page: int
    brand: str = ""
    category: str = ""
    skus: list[str] = Field(default_factory=list)
    product_names: list[str] = Field(default_factory=list)
    has_price: bool = False
    chunk_type: str = "page"
    score: float = 0.0
    # Precios del payload (para ordenar por precio real; None si no aplica).
    # Nunca exponer aquí cost_internal_usd.
    price_net_usd: float | None = None
    price_list_usd: float | None = None
    price_status: str = ""

    def cite(self) -> str:
        return f"[{self.source_file}, pág. {self.page}]"

    @property
    def price(self) -> float | None:
        """Precio comparable: neto si existe, si no lista."""
        return self.price_net_usd if self.price_net_usd is not None else self.price_list_usd


class SearchFilters(BaseModel):
    brand: str | None = None
    category: str | None = None
    # Línea comercial (payload `supplier`): filtro exacto y confiable, viene
    # del archivo de origen y no sufre los errores de etiquetado de `brand`.
    supplier: str | None = None


class SourceRef(BaseModel):
    """Fuente mostrada al usuario junto a la respuesta.

    Los campos de producto (skus, product_names, category, chunk_type) permiten
    al frontend titular cada fuente por lo que ES, no solo por archivo+página.
    Nunca incluir aquí campos internos (cost_internal_usd, visibility).
    """

    source_file: str
    page: int
    brand: str = ""
    snippet: str = ""
    score: float = 0.0
    skus: list[str] = Field(default_factory=list)
    product_names: list[str] = Field(default_factory=list)
    category: str = ""
    chunk_type: str = "page"
