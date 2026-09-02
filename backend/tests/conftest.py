"""Fixtures compartidas por todos los tests del backend.

Ningún test toca la red: OpenAI se sustituye por `FakeAsyncOpenAI` (respuestas
programadas con `fake.queue(...)`), Qdrant por un espía que registra llamadas
y devuelve resultados configurables, y los settings se fijan por variables de
entorno para que el `backend/.env` local nunca contamine una corrida.

Uso típico:

    async def test_algo(settings_override, fake_openai):
        fake_openai.queue(make_text_stream("hola", usage=make_usage(10, 2)))
        ...
"""
from __future__ import annotations

import copy
import json
import re
import types
from collections import deque
from typing import Any, Iterable

import pytest

from app.config import get_settings
from app.services import openai_client, telemetry

# Entorno mínimo y determinista para los tests. Las variables de entorno
# tienen prioridad sobre `env_file` en pydantic-settings (lo comprueba
# tests/test_settings.py), así que esto pisa cualquier valor del .env local.
TEST_ENV: dict[str, str] = {
    "OPENAI_API_KEY": "test-key",
    "OPENAI_MODEL": "gpt-5.4",
    "RERANK_MODEL": "gpt-5.4-mini",
    "QDRANT_URL": "http://qdrant.invalid:6333",
    "QDRANT_API_KEY": "",
    "SUPABASE_URL": "",
    "SUPABASE_SERVICE_KEY": "",
    "MAX_HOPS": "4",
    "ENVIRONMENT": "local",
}


# ---------------------------------------------------------------------------
# Settings aislados
# ---------------------------------------------------------------------------
@pytest.fixture
def settings_override(monkeypatch: pytest.MonkeyPatch):
    """Fija el entorno de tests, vacía la caché de `get_settings` y olvida los
    clientes OpenAI antes y después. Devuelve el `Settings` resultante.

    Para cambiar un valor dentro de un test: `monkeypatch.setenv("MAX_HOPS",
    "1")` seguido de `get_settings.cache_clear()`.
    """
    for key, value in TEST_ENV.items():
        monkeypatch.setenv(key, value)
    get_settings.cache_clear()
    openai_client.reset_clients()
    telemetry.clear()
    try:
        yield get_settings()
    finally:
        get_settings.cache_clear()
        openai_client.reset_clients()
        telemetry.clear()


# ---------------------------------------------------------------------------
# OpenAI falso
# ---------------------------------------------------------------------------
def make_usage(
    prompt: int = 0,
    completion: int = 0,
    cached: int = 0,
    reasoning: int = 0,
) -> types.SimpleNamespace:
    """`usage` con la forma del SDK (incluye los detalles de cacheado y
    razonamiento que lee `telemetry.usage_to_dict`)."""
    return types.SimpleNamespace(
        prompt_tokens=prompt,
        completion_tokens=completion,
        total_tokens=prompt + completion,
        prompt_tokens_details=types.SimpleNamespace(cached_tokens=cached),
        completion_tokens_details=types.SimpleNamespace(reasoning_tokens=reasoning),
    )


def _chunk(
    choices: list[Any],
    usage: Any = None,
    model: str | None = None,
) -> types.SimpleNamespace:
    return types.SimpleNamespace(
        id="chatcmpl-fake",
        object="chat.completion.chunk",
        model=model,
        choices=choices,
        usage=usage,
    )


def _choice(
    content: str | None = None,
    tool_calls: list[Any] | None = None,
    finish_reason: str | None = None,
) -> types.SimpleNamespace:
    return types.SimpleNamespace(
        index=0,
        delta=types.SimpleNamespace(
            role=None, content=content, tool_calls=tool_calls
        ),
        finish_reason=finish_reason,
    )


def _tool_call_delta(
    index: int,
    call_id: str | None = None,
    name: str | None = None,
    arguments: str | None = None,
) -> types.SimpleNamespace:
    return types.SimpleNamespace(
        index=index,
        id=call_id,
        type="function" if call_id else None,
        function=types.SimpleNamespace(name=name, arguments=arguments),
    )


class FakeStream:
    """Iterador asíncrono de chunks, como el `AsyncStream` del SDK."""

    def __init__(self, chunks: Iterable[Any]):
        self._chunks = list(chunks)
        self.consumed: list[Any] = []

    def __aiter__(self) -> "FakeStream":
        self._it = iter(self._chunks)
        return self

    async def __anext__(self) -> Any:
        try:
            chunk = next(self._it)
        except StopIteration:
            raise StopAsyncIteration
        self.consumed.append(chunk)
        return chunk


def make_tool_call_stream(
    name: str,
    args: dict[str, Any],
    call_id: str = "call_1",
    usage: Any = None,
    model: str | None = None,
) -> FakeStream:
    """Stream de una ronda que acaba en tool call. Los argumentos JSON llegan
    partidos en dos deltas, como hace el API, para probar la concatenación.
    El último chunk lleva `choices=[]` y el `usage` (stream_options
    include_usage)."""
    payload = json.dumps(args, ensure_ascii=False)
    cut = max(1, len(payload) // 2)
    chunks = [
        _chunk([_choice(tool_calls=[_tool_call_delta(0, call_id=call_id, name=name, arguments="")])], model=model),
        _chunk([_choice(tool_calls=[_tool_call_delta(0, arguments=payload[:cut])])], model=model),
        _chunk([_choice(tool_calls=[_tool_call_delta(0, arguments=payload[cut:])])], model=model),
        _chunk([_choice(finish_reason="tool_calls")], model=model),
        _chunk([], usage=usage, model=model),
    ]
    return FakeStream(chunks)


def make_text_stream(
    text: str,
    usage: Any = None,
    finish_reason: str = "stop",
    model: str | None = None,
) -> FakeStream:
    """Stream de texto: un delta por palabra (conservando espacios exactos),
    luego el chunk de cierre con `finish_reason` y el chunk final con usage."""
    pieces = re.findall(r"\S+\s*|\s+", text) or [text]
    chunks = [_chunk([_choice(content=p)], model=model) for p in pieces]
    chunks.append(_chunk([_choice(finish_reason=finish_reason)], model=model))
    chunks.append(_chunk([], usage=usage, model=model))
    return FakeStream(chunks)


def make_json_completion(
    obj: Any,
    usage: Any = None,
    model: str | None = None,
    finish_reason: str = "stop",
) -> types.SimpleNamespace:
    """Completion no-stream (response_format json_object) con `obj` serializado
    en `choices[0].message.content`."""
    message = types.SimpleNamespace(
        role="assistant", content=json.dumps(obj, ensure_ascii=False), tool_calls=None
    )
    return types.SimpleNamespace(
        id="chatcmpl-fake",
        object="chat.completion",
        model=model,
        choices=[types.SimpleNamespace(index=0, message=message, finish_reason=finish_reason)],
        usage=usage,
    )


def make_embeddings_response(
    n: int, dims: int = 4, model: str | None = None, prompt_tokens: int | None = None
) -> types.SimpleNamespace:
    """Respuesta de embeddings con `n` vectores de ceros de `dims` dimensiones."""
    return types.SimpleNamespace(
        object="list",
        model=model,
        data=[
            types.SimpleNamespace(object="embedding", index=i, embedding=[0.0] * dims)
            for i in range(n)
        ],
        usage=types.SimpleNamespace(
            prompt_tokens=prompt_tokens if prompt_tokens is not None else n * 8,
            total_tokens=prompt_tokens if prompt_tokens is not None else n * 8,
        ),
    )


def _snapshot(kwargs: dict[str, Any]) -> dict[str, Any]:
    """Copia profunda de los kwargs: el agente muta `messages` in place entre
    rondas y queremos ver lo que cada llamada recibió en su momento."""
    try:
        return copy.deepcopy(kwargs)
    except Exception:
        return dict(kwargs)


class _FakeOpenAIBase:
    """Lógica común de los falsos (sync y async): colas de respuestas y
    registro de llamadas. Cada respuesta programada puede ser un valor a
    devolver o una excepción a lanzar."""

    def __init__(self, embedding_dims: int = 4):
        self.calls: list[dict[str, Any]] = []
        self.embedding_calls: list[dict[str, Any]] = []
        self.embedding_dims = embedding_dims
        self._chat_queue: deque[Any] = deque()
        self._embed_queue: deque[Any] = deque()

    def queue(self, *responses: Any) -> None:
        """Programa respuestas de chat.completions.create en orden."""
        self._chat_queue.extend(responses)

    def queue_embeddings(self, *responses: Any) -> None:
        """Programa respuestas (o excepciones) de embeddings.create. Sin cola,
        embeddings.create devuelve vectores de ceros."""
        self._embed_queue.extend(responses)

    @property
    def pending(self) -> int:
        return len(self._chat_queue)

    def _next_chat(self, kwargs: dict[str, Any]) -> Any:
        self.calls.append(_snapshot(kwargs))
        if not self._chat_queue:
            raise AssertionError(
                "FakeOpenAI: chat.completions.create sin respuesta programada "
                f"(llamada #{len(self.calls)}); usa fake.queue(...)"
            )
        item = self._chat_queue.popleft()
        if isinstance(item, BaseException):
            raise item
        return item

    def _next_embeddings(self, model: str, inputs: Any, kwargs: dict[str, Any]) -> Any:
        texts = [inputs] if isinstance(inputs, str) else list(inputs)
        self.embedding_calls.append({"model": model, "input": texts, **kwargs})
        if self._embed_queue:
            item = self._embed_queue.popleft()
            if isinstance(item, BaseException):
                raise item
            return item
        return make_embeddings_response(len(texts), self.embedding_dims, model=model)


class FakeAsyncOpenAI(_FakeOpenAIBase):
    """Sustituto de `openai.AsyncOpenAI` con la superficie que usa el backend:
    `.chat.completions.create(**kwargs)` y `.embeddings.create(model, input)`."""

    def __init__(self, embedding_dims: int = 4):
        super().__init__(embedding_dims)
        self.chat = types.SimpleNamespace(
            completions=types.SimpleNamespace(create=self._create_chat)
        )
        self.embeddings = types.SimpleNamespace(create=self._create_embeddings)

    async def _create_chat(self, **kwargs: Any) -> Any:
        return self._next_chat(kwargs)

    async def _create_embeddings(self, model: str, input: Any, **kwargs: Any) -> Any:
        return self._next_embeddings(model, input, kwargs)


class FakeSyncOpenAI(_FakeOpenAIBase):
    """Sustituto de `openai.OpenAI` (ingesta, `embed_texts`)."""

    def __init__(self, embedding_dims: int = 4):
        super().__init__(embedding_dims)
        self.chat = types.SimpleNamespace(
            completions=types.SimpleNamespace(create=self._create_chat)
        )
        self.embeddings = types.SimpleNamespace(create=self._create_embeddings)

    def _create_chat(self, **kwargs: Any) -> Any:
        return self._next_chat(kwargs)

    def _create_embeddings(self, model: str, input: Any, **kwargs: Any) -> Any:
        return self._next_embeddings(model, input, kwargs)


@pytest.fixture
def fake_openai(settings_override):
    """Instala un `FakeAsyncOpenAI` como cliente asíncrono del backend y lo
    retira al terminar."""
    fake = FakeAsyncOpenAI()
    openai_client.set_async_client_for_tests(fake)  # type: ignore[arg-type]
    try:
        yield fake
    finally:
        openai_client.set_async_client_for_tests(None)


# ---------------------------------------------------------------------------
# Qdrant espía
# ---------------------------------------------------------------------------
class FakeQdrant:
    """Espía mínimo del `QdrantClient`: registra `(metodo, kwargs)` en
    `.calls` y responde con `.responses[metodo]`, que puede ser un valor fijo
    o un callable que recibe los kwargs. Los defaults describen una colección
    vacía pero existente."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.responses: dict[str, Any] = {
            "count": types.SimpleNamespace(count=0),
            "scroll": ([], None),
            "query_points": types.SimpleNamespace(points=[]),
            "facet": types.SimpleNamespace(hits=[]),
            "get_collection": types.SimpleNamespace(
                points_count=0, status="green", payload_schema={}
            ),
            "collection_exists": True,
            "create_payload_index": None,
            "info": types.SimpleNamespace(version="test", title="qdrant"),
            "upsert": None,
            "delete": None,
            "create_collection": True,
            "delete_collection": True,
        }

    def set_response(self, method: str, value: Any) -> None:
        self.responses[method] = value

    def calls_to(self, method: str) -> list[dict[str, Any]]:
        return [kw for m, kw in self.calls if m == method]

    def _respond(self, method: str, args: tuple[Any, ...], kwargs: dict[str, Any]) -> Any:
        if args:
            kwargs = {"_args": list(args), **kwargs}
        self.calls.append((method, kwargs))
        value = self.responses.get(method)
        if isinstance(value, BaseException):
            raise value
        if callable(value):
            return value(kwargs)
        return value

    def count(self, *args: Any, **kwargs: Any) -> Any:
        return self._respond("count", args, kwargs)

    def scroll(self, *args: Any, **kwargs: Any) -> Any:
        return self._respond("scroll", args, kwargs)

    def query_points(self, *args: Any, **kwargs: Any) -> Any:
        return self._respond("query_points", args, kwargs)

    def facet(self, *args: Any, **kwargs: Any) -> Any:
        return self._respond("facet", args, kwargs)

    def get_collection(self, *args: Any, **kwargs: Any) -> Any:
        return self._respond("get_collection", args, kwargs)

    def collection_exists(self, *args: Any, **kwargs: Any) -> Any:
        return self._respond("collection_exists", args, kwargs)

    def create_payload_index(self, *args: Any, **kwargs: Any) -> Any:
        return self._respond("create_payload_index", args, kwargs)

    def info(self, *args: Any, **kwargs: Any) -> Any:
        return self._respond("info", args, kwargs)

    def upsert(self, *args: Any, **kwargs: Any) -> Any:
        return self._respond("upsert", args, kwargs)

    def delete(self, *args: Any, **kwargs: Any) -> Any:
        return self._respond("delete", args, kwargs)

    def create_collection(self, *args: Any, **kwargs: Any) -> Any:
        return self._respond("create_collection", args, kwargs)

    def delete_collection(self, *args: Any, **kwargs: Any) -> Any:
        return self._respond("delete_collection", args, kwargs)


@pytest.fixture
def fake_qdrant(monkeypatch: pytest.MonkeyPatch, settings_override):
    """Parchea `app.services.qdrant.get_client` (y el singleton `_client`)
    para que todo el módulo hable con el espía."""
    from app.services import qdrant as qdrant_module

    spy = FakeQdrant()
    monkeypatch.setattr(qdrant_module, "get_client", lambda: spy)
    if hasattr(qdrant_module, "_client"):
        monkeypatch.setattr(qdrant_module, "_client", spy)
    if hasattr(qdrant_module, "_server_version"):
        monkeypatch.setattr(qdrant_module, "_server_version", None)
    yield spy
