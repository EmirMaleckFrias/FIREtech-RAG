"""Reranker listwise, filtro binario y calificador pointwise con completions JSON falsas."""
from __future__ import annotations

import asyncio

from app.config import get_settings
from app.models import Chunk
from app.services import openai_client, reranker, telemetry
from app.services.reranker import calificar_evidencia, filter_relevant, rerank
from tests.conftest import make_json_completion, make_usage


def _chunks(n: int) -> list[Chunk]:
    return [
        Chunk(id=f"c{i}", text=f"producto {i}", source_file="cat.pdf", page=i + 1)
        for i in range(n)
    ]


def _ids(chunks: list[Chunk]) -> list[str]:
    return [c.id for c in chunks]


# --- filter_relevant --------------------------------------------------------
async def test_filter_relevant_conserva_el_orden(settings_override, fake_openai):
    chunks = _chunks(3)
    fake_openai.queue(make_json_completion({"relevantes": [2, 0]}, usage=make_usage(50, 5)))

    out = await filter_relevant("detector", chunks)

    assert _ids(out.kept) == ["c0", "c2"]  # orden de entrada, no el del JSON
    assert out.verificado is True
    assert len(fake_openai.calls) == 1
    kwargs = fake_openai.calls[0]
    assert kwargs["model"] == settings_override.rerank_model_resolved
    assert kwargs["response_format"] == {"type": "json_object"}
    assert "detector" in kwargs["messages"][-1]["content"]
    assert "[2] producto 2" in kwargs["messages"][-1]["content"]


async def test_filter_relevant_respuesta_ilegible_no_se_da_por_verificada(
    settings_override, fake_openai
):
    """JSON sin la lista esperada: se devuelven todos, pero SIN verificar.

    Es la diferencia que importa: nadie puede concluir de aquí que los tres
    fragmentos sirvan, solo que el filtro no se pudo aplicar.
    """
    chunks = _chunks(3)
    fake_openai.queue(make_json_completion({"relevantes": "todos"}, usage=make_usage(50, 5)))
    out = await filter_relevant("detector", chunks)
    assert _ids(out.kept) == ["c0", "c1", "c2"]
    assert out.verificado is False

    fake_openai.queue(make_json_completion({}, usage=make_usage(50, 5)))
    out = await filter_relevant("detector", chunks)
    assert _ids(out.kept) == ["c0", "c1", "c2"]
    assert out.verificado is False


async def test_filter_relevant_ninguno_relevante_es_una_respuesta_legitima(
    settings_override, fake_openai
):
    """Lista vacía verificada: el índice no cubre el tema, y hay que decirlo."""
    chunks = _chunks(3)
    fake_openai.queue(make_json_completion({"relevantes": []}))

    out = await filter_relevant("x", chunks)

    assert out.kept == []
    assert out.verificado is True


async def test_filter_relevant_ignora_indices_invalidos(settings_override, fake_openai):
    chunks = _chunks(3)
    fake_openai.queue(make_json_completion({"relevantes": [7, -1, "no", True, 1]}))

    out = await filter_relevant("x", chunks)

    assert _ids(out.kept) == ["c1"]
    assert out.verificado is True


async def test_filter_relevant_con_un_solo_chunk_no_llama(settings_override, fake_openai):
    chunks = _chunks(1)

    out = await filter_relevant("x", chunks)

    assert out.kept == chunks
    # No se llamó al modelo, así que no se puede afirmar que sea relevante.
    assert out.verificado is False
    assert fake_openai.calls == []


async def test_filter_relevant_si_el_api_falla_devuelve_todos_sin_verificar(
    settings_override, fake_openai
):
    chunks = _chunks(3)
    fake_openai.queue(RuntimeError("api caída"))
    tel = telemetry.start()

    out = await filter_relevant("x", chunks)

    assert _ids(out.kept) == ["c0", "c1", "c2"]
    assert out.verificado is False
    assert len(tel.rounds) == 1 and tel.rounds[0].ok is False
    assert tel.rounds[0].component == "reranker"


# --- rerank -----------------------------------------------------------------
async def test_rerank_reordena_y_corta_a_top_k(settings_override, fake_openai):
    chunks = _chunks(3)
    fake_openai.queue(make_json_completion({"ranking": [2, 0, 1]}, usage=make_usage(60, 6)))

    out = await rerank("valvula", chunks, top_k=2)

    assert _ids(out) == ["c2", "c0"]
    assert fake_openai.calls[0]["model"] == settings_override.rerank_model_resolved


async def test_rerank_ranking_parcial_anexa_los_que_faltan(settings_override, fake_openai):
    chunks = _chunks(4)
    fake_openai.queue(make_json_completion({"ranking": [3, 3, "x", 1]}))
    # Duplicados e inválidos se ignoran; c0 y c2 se anexan en su orden original.
    out = await rerank("q", chunks, top_k=3)
    assert _ids(out) == ["c3", "c1", "c0"]


async def test_rerank_con_pocos_candidatos_no_llama(settings_override, fake_openai):
    chunks = _chunks(3)
    assert await rerank("q", chunks, top_k=3) == chunks
    assert fake_openai.calls == []


async def test_rerank_si_falla_mantiene_orden_de_qdrant(settings_override, fake_openai):
    chunks = _chunks(4)
    fake_openai.queue(RuntimeError("timeout"))
    assert _ids(await rerank("q", chunks, top_k=2)) == ["c0", "c1"]


async def test_rerank_sin_contenido_cae_al_fallback_con_log(settings_override, fake_openai, caplog):
    # content=None (refusal, content_filter): antes se leía como {} en silencio
    # y la ronda quedaba ok=True aunque el modelo no hubiera rankeado nada.
    chunks = _chunks(4)
    completion = make_json_completion({}, usage=make_usage(40, 0), finish_reason="content_filter")
    completion.choices[0].message.content = None
    fake_openai.queue(completion)
    tel = telemetry.start()

    with caplog.at_level("WARNING"):
        out = await rerank("q", chunks, top_k=2)

    assert _ids(out) == ["c0", "c1"]  # orden de Qdrant intacto
    assert any("Reranker LLM" in r.getMessage() for r in caplog.records)
    assert len(tel.rounds) == 1
    assert tel.rounds[0].ok is False
    assert "sin contenido" in tel.rounds[0].note
    assert tel.rounds[0].prompt == 40  # el usage real se conserva


# --- telemetría -------------------------------------------------------------
async def test_telemetria_registra_componente_reranker(settings_override, fake_openai):
    chunks = _chunks(3)
    fake_openai.queue(
        make_json_completion({"ranking": [1, 0, 2]}, usage=make_usage(300, 12, cached=100)),
        make_json_completion({"relevantes": [0]}, usage=make_usage(200, 4)),
    )
    tel = telemetry.start()

    await rerank("q", chunks, top_k=2)
    await filter_relevant("q", chunks)

    rondas = [r for r in tel.rounds if r.component == "reranker"]
    assert len(rondas) == 2
    assert all(r.model == settings_override.rerank_model_resolved for r in rondas)
    assert [r.prompt for r in rondas] == [300, 200]
    assert [r.completion for r in rondas] == [12, 4]
    assert rondas[0].cached == 100
    assert all(r.ok and r.finish_reason == "stop" for r in rondas)
    assert rondas[0].note.startswith("rerank n=3 top_k=2")
    assert rondas[1].note.startswith("filter_relevant n=3")
    assert tel.by_component()["reranker"]["rounds"] == 2
    # El modelo del completion, si viene, manda sobre el pedido (snapshot).
    fake_openai.queue(
        make_json_completion({"ranking": [0, 1, 2]}, model="gpt-5.4-mini-2026-01-01")
    )
    await rerank("q", chunks, top_k=1)
    assert tel.rounds[-1].model == "gpt-5.4-mini-2026-01-01"
    assert tel.summary()["unknown_models"] == []


# --- calificar_evidencia ----------------------------------------------------
def _grados(pares: dict[int, str]) -> dict:
    """Respuesta del calificador con la forma del contrato."""
    return {
        "fragmentos": [
            {"i": i, "grado": g, "motivo": f"motivo {i}"} for i, g in pares.items()
        ]
    }


def _mensaje_usuario(fake_openai, n: int = -1) -> str:
    return fake_openai.calls[n]["messages"][-1]["content"]


async def test_calificar_manda_el_texto_completo_sin_truncar(settings_override, fake_openai):
    """La cifra clave en el carácter 1500 debe llegar al modelo: el filtro
    binario la perdía porque cortaba a 450."""
    relleno = "palabra " * 190  # 1520 caracteres
    ch = Chunk(id="c0", text=relleno + "la tasa de conversión fue del 42,7 % a 24 meses",
               source_file="a.pdf", page=1)
    fake_openai.queue(make_json_completion(_grados({0: "directa"})))

    out = await calificar_evidencia("conversión a demencia", "tasa de conversión", [ch])

    assert out.grados == {0: "directa"}
    assert out.verificado is True
    contenido = _mensaje_usuario(fake_openai)
    assert "42,7 % a 24 meses" in contenido
    assert relleno in contenido  # sin truncar: todo el texto, no un prefijo
    assert "conversión a demencia" in contenido
    assert "tasa de conversión" in contenido


async def test_calificar_cabecera_lleva_fuente_seccion_tipo_y_cita(settings_override, fake_openai):
    con_todo = Chunk(
        id="c0", text="Tabla 2. Conversión por grupo.", source_file="allegri.pdf", page=4,
        citation="Allegri et al., 2023", section="Resultados", chunk_type="table",
        document_type="pdf",
    )
    sin_nada = Chunk(id="c1", text="texto plano", source_file="notas.txt", page=2)
    fake_openai.queue(make_json_completion(_grados({0: "directa", 1: "no"})))

    await calificar_evidencia("q", "e", [con_todo, sin_nada])

    contenido = _mensaje_usuario(fake_openai)
    assert (
        "[0] fuente: Allegri et al., 2023 · seccion: Resultados · tipo: tabla "
        "· cita: [Allegri et al., 2023, pág. 4]\nTabla 2. Conversión por grupo."
    ) in contenido
    # Sin cita se nombra por archivo; sin sección se dice que es desconocida,
    # no se deja un hueco que el modelo pueda leer como "sección vacía".
    assert (
        "[1] fuente: notas.txt · seccion: desconocida · tipo: texto "
        "· cita: [notas.txt, fragmento 2]\ntexto plano"
    ) in contenido


async def test_calificar_usa_el_modelo_de_rerank_con_json_y_razonamiento(
    settings_override, fake_openai
):
    fake_openai.queue(make_json_completion(_grados({0: "parcial"})))
    await calificar_evidencia("q", "e", _chunks(1))
    kwargs = fake_openai.calls[0]
    assert kwargs["model"] == settings_override.rerank_model_resolved
    assert kwargs["response_format"] == {"type": "json_object"}
    assert kwargs["reasoning_effort"] == settings_override.rerank_reasoning_effort
    assert kwargs["temperature"] == settings_override.llm_temperature


async def test_calificar_un_solo_fragmento_si_se_califica(settings_override, fake_openai):
    """A diferencia de filter_relevant (que con un candidato no llama), el
    juicio pointwise tiene sentido con uno solo: la pregunta es si ESE
    fragmento aporta el dato, no cuál de varios."""
    fake_openai.queue(make_json_completion(_grados({0: "no"})))
    out = await calificar_evidencia("q", "e", _chunks(1))
    assert out == reranker.Calificacion({0: "no"}, True, "0 directa, 0 parcial, 1 no de 1 fragmentos")
    assert len(fake_openai.calls) == 1


async def test_calificar_lista_vacia_no_llama(settings_override, fake_openai):
    out = await calificar_evidencia("q", "e", [])
    assert out.grados == {}
    assert out.verificado is True
    assert fake_openai.calls == []


async def test_calificar_parseo_con_basura(settings_override, fake_openai):
    """Índices fuera de rango, repetidos o booleanos, grados fuera de GRADOS y
    entradas que no son objetos se ignoran uno a uno; el resto se conserva."""
    chunks = _chunks(3)
    fake_openai.queue(make_json_completion({"fragmentos": [
        {"i": 0, "grado": "directa", "motivo": "ok"},
        {"i": 0, "grado": "no"},            # repetido: gana el primero
        {"i": 7, "grado": "parcial"},       # fuera de rango
        {"i": -1, "grado": "parcial"},      # fuera de rango
        {"i": True, "grado": "directa"},    # booleano
        {"i": 1, "grado": "quizás"},        # grado inventado
        {"i": 1, "grado": 2},               # grado que no es texto
        "basura",                           # no es un objeto
        {"grado": "no"},                    # sin índice
        {"i": "2", "grado": " Parcial "},   # índice como texto y grado con mayúscula: se acepta
    ]}))

    out = await calificar_evidencia("q", "e", chunks)

    assert out.grados == {0: "directa", 2: "parcial"}
    assert out.verificado is True
    assert "1 sin calificar por el modelo" in out.motivo


async def test_calificar_sin_lista_fragmentos_no_se_da_por_verificado(settings_override, fake_openai):
    """JSON sin la lista esperada: NO hay grados y nadie puede concluir nada.
    Es el análogo del test de filter_relevant con {"relevantes": "todos"}."""
    chunks = _chunks(2)
    fake_openai.queue(make_json_completion({"fragmentos": "todos directa"}))
    out = await calificar_evidencia("q", "e", chunks)
    assert out.grados == {}
    assert out.verificado is False
    assert "1 de 1 lotes fallaron" in out.motivo

    fake_openai.queue(make_json_completion({}))
    out = await calificar_evidencia("q", "e", chunks)
    assert out.grados == {}
    assert out.verificado is False


async def test_calificar_lotes_paralelos_reindexados_al_indice_global(settings_override, fake_openai):
    """35 fragmentos -> 2 llamadas (20 + 15). La cabecera lleva el índice
    global, así el modelo lo copia y el resultado cae en el índice correcto."""
    chunks = _chunks(35)
    fake_openai.queue(
        make_json_completion(_grados({i: ("directa" if i % 2 == 0 else "no") for i in range(20)})),
        make_json_completion(_grados({i: "parcial" for i in range(20, 35)})),
    )
    tel = telemetry.start()

    out = await calificar_evidencia("q", "e", chunks)

    assert len(fake_openai.calls) == 2
    assert out.verificado is True
    assert len(out.grados) == 35
    assert out.grados[0] == "directa" and out.grados[1] == "no" and out.grados[19] == "no"
    assert all(out.grados[i] == "parcial" for i in range(20, 35))
    assert list(out.grados) == list(range(35))  # orden estable por índice
    # Cada lote lleva SOLO sus fragmentos, con su índice global.
    primero, segundo = _mensaje_usuario(fake_openai, 0), _mensaje_usuario(fake_openai, 1)
    assert "[0] fuente: cat.pdf" in primero and "[19] fuente: cat.pdf" in primero
    assert "[20] fuente" not in primero
    assert "[20] fuente: cat.pdf" in segundo and "[34] fuente: cat.pdf" in segundo
    assert "[0] fuente" not in segundo and "[19] fuente" not in segundo
    assert "\nproducto 20\n" in segundo and segundo.count("\nproducto 34") == 1
    assert "\nproducto 0\n" not in segundo and "\nproducto 19\n" not in segundo
    assert "índices 20 a 34" in segundo
    # Telemetría: componente propio, nota con n y lote.
    rondas = [r for r in tel.rounds if r.component == "grader"]
    assert [r.note for r in rondas] == ["calificar n=35 lote=1/2", "calificar n=35 lote=2/2"]
    assert all(r.ok for r in rondas)
    assert "reranker" not in tel.by_component()


async def test_calificar_indices_locales_en_el_segundo_lote_se_ignoran(settings_override, fake_openai):
    """Adversarial: si el modelo devolviera índices 0..14 para el segundo lote
    (como si empezara de cero), no deben pisar los grados del primero. Los
    índices fuera de la ventana del lote se descartan."""
    chunks = _chunks(35)
    fake_openai.queue(
        make_json_completion(_grados({i: "directa" for i in range(20)})),
        make_json_completion(_grados({i: "no" for i in range(15)})),
    )
    out = await calificar_evidencia("q", "e", chunks)
    assert all(out.grados[i] == "directa" for i in range(20))
    assert all(i not in out.grados for i in range(20, 35))
    assert out.verificado is True
    assert "15 sin calificar por el modelo" in out.motivo


async def test_calificar_un_lote_caido_conserva_los_grados_de_los_otros(settings_override, fake_openai, caplog):
    chunks = _chunks(35)
    fake_openai.queue(
        make_json_completion(_grados({i: "parcial" for i in range(20)})),
        RuntimeError("timeout"),
    )
    tel = telemetry.start()

    with caplog.at_level("WARNING"):
        out = await calificar_evidencia("q", "e", chunks)

    assert out.verificado is False
    assert "1 de 2 lotes fallaron" in out.motivo
    assert "15 fragmentos sin calificar" in out.motivo
    assert out.grados == {i: "parcial" for i in range(20)}
    assert any("lote 2/2" in r.getMessage() for r in caplog.records)
    rondas = [r for r in tel.rounds if r.component == "grader"]
    assert [r.ok for r in rondas] == [True, False]
    assert rondas[1].note.startswith("calificar n=35 lote=2/2: timeout")


async def test_calificar_todos_los_lotes_caidos(settings_override, fake_openai):
    chunks = _chunks(45)  # 3 lotes: 20 + 20 + 5
    fake_openai.queue(RuntimeError("a"), RuntimeError("b"), RuntimeError("c"))
    out = await calificar_evidencia("q", "e", chunks)
    assert out.grados == {}
    assert out.verificado is False
    assert "3 de 3 lotes fallaron" in out.motivo
    assert len(fake_openai.calls) == 3


async def test_calificar_es_determinista_dada_la_misma_respuesta(settings_override, fake_openai):
    chunks = _chunks(25)
    respuesta_a = {i: ("directa" if i % 3 == 0 else "parcial") for i in range(20)}
    respuesta_b = {i: "no" for i in range(20, 25)}
    # El JSON del modelo llega desordenado: el resultado no debe depender de eso.
    desordenado = {"fragmentos": list(reversed(_grados(respuesta_b)["fragmentos"]))}
    fake_openai.queue(
        make_json_completion(_grados(respuesta_a)), make_json_completion(_grados(respuesta_b)),
        make_json_completion(_grados(respuesta_a)), make_json_completion(desordenado),
    )

    uno = await calificar_evidencia("q", "e", chunks)
    dos = await calificar_evidencia("q", "e", chunks)

    assert uno == dos
    assert list(uno.grados) == list(range(25))
    assert fake_openai.calls[0]["messages"] == fake_openai.calls[2]["messages"]
    assert fake_openai.calls[1]["messages"] == fake_openai.calls[3]["messages"]


async def test_calificar_lotes_corren_en_paralelo_bajo_el_semaforo(
    settings_override, fake_openai, monkeypatch
):
    """Con 3 lotes y concurrencia 6 hay 3 llamadas en vuelo a la vez (un bucle
    secuencial daría 1); con concurrencia 1 el semáforo las serializa. Se
    parchea crear_completion para poder observar el solapamiento."""
    en_vuelo = {"ahora": 0, "max": 0}

    async def crear_lento(client, kwargs):
        en_vuelo["ahora"] += 1
        en_vuelo["max"] = max(en_vuelo["max"], en_vuelo["ahora"])
        await asyncio.sleep(0.02)
        en_vuelo["ahora"] -= 1
        return make_json_completion({"fragmentos": []})

    monkeypatch.setattr(reranker, "crear_completion", crear_lento)
    chunks = _chunks(45)

    out = await calificar_evidencia("q", "e", chunks)
    assert out.verificado is True
    assert en_vuelo["max"] == 3

    monkeypatch.setenv("OPENAI_CONCURRENCY", "1")
    get_settings.cache_clear()
    openai_client.reset_clients()  # el semáforo se crea con el valor de settings
    openai_client.set_async_client_for_tests(fake_openai)
    en_vuelo["max"] = 0

    out = await calificar_evidencia("q", "e", chunks)
    assert out.verificado is True
    assert en_vuelo["max"] == 1
