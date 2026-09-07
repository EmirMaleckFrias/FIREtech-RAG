// Un diagrama Mermaid dentro de una respuesta.
//
// Mermaid pesa (varios cientos de KB), así que se carga SOLO cuando una
// respuesta trae un diagrama: `import('mermaid')` dinámico, que Vite deja en su
// propio trozo. Quien nunca vea un diagrama no descarga nada, y el service
// worker cachea el trozo como cualquier asset hasheado, así que a partir del
// primero también funciona sin red.
//
// Tres reglas que no conviene relajar:
//
// - **`securityLevel: 'strict'`**. El diagrama lo escribe un modelo, o sea que
//   es contenido no confiable: en 'loose' Mermaid interpreta HTML dentro de las
//   etiquetas de los nodos y eso es una inyección con pasos extra.
// - **Si algo falla, se degrada, no se rompe.** Mermaid que no carga (sin red y
//   sin caché) o sintaxis que no compila (el modelo se equivoca) caen a la
//   lista de pasos nativa, que es legible igual; si tampoco hay pasos, al
//   bloque de código. Un diagrama que no se puede pintar nunca debe dejar un
//   hueco en blanco en medio de una respuesta clínica.
// - **El tema se sigue.** El diagrama se vuelve a pintar al cambiar de claro a
//   oscuro; si no, queda un rectángulo blanco en una interfaz oscura.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { createPortal } from 'react-dom';
import { parsearFlujo, type PasoFlujo } from '../lib/markdown';
import { IconMaximize, IconMinus, IconPlus, IconX } from './icons';

interface DiagramaProps {
  /** El código Mermaid tal cual lo escribió el modelo. */
  codigo: string;
  /** Los pasos a los que caer si Mermaid no puede pintarlo. */
  respaldo: PasoFlujo[];
}

/** Un id único por diagrama: Mermaid lo usa para el `<svg>` que genera. */
let contador = 0;

/** El valor de un token CSS del tema vigente, para pasárselo a Mermaid (que
 *  no entiende `var(--x)` porque escribe atributos en el SVG). */
function colorDeToken(token: string, respaldo: 'dark' | 'light'): string {
  if (typeof getComputedStyle === 'undefined') return respaldo === 'dark' ? '#171717' : '#ffffff';
  const valor = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return valor || (respaldo === 'dark' ? '#171717' : '#ffffff');
}

/**
 * La paleta de los diagramas, por tema.
 *
 * Mermaid por defecto pinta todo del mismo lavanda (claro) o del mismo gris
 * (oscuro), y un algoritmo clínico de seis cajas iguales se lee como una
 * lista con flechas. Aquí cada rama del mapa mental lleva un tono distinto
 * (`cScale*`, con su texto en `cScaleLabel*`), y el flowchart usa el morado de
 * la marca en los nodos con el resto de tonos para lo secundario. Los tonos
 * son los de la biblioteca de documentos (teal, azul, verde, morado, ámbar),
 * aclarados u oscurecidos según el fondo para que el texto siga leyéndose.
 */
export function variablesDeTema(tema: 'dark' | 'light', superficie: string): Record<string, string> {
  const claro = tema === 'light';
  const ramas = claro
    ? ['#ede9fe', '#ccfbf1', '#dbeafe', '#dcfce7', '#fef3c7', '#ffe4e6', '#e0e7ff', '#cffafe']
    : ['#4c1d95', '#134e4a', '#1e3a8a', '#14532d', '#78350f', '#881337', '#312e81', '#164e63'];
  const textos = claro
    ? ['#3b0764', '#134e4a', '#1e3a8a', '#14532d', '#78350f', '#881337', '#312e81', '#164e63']
    : ['#ede9fe', '#ccfbf1', '#dbeafe', '#dcfce7', '#fef3c7', '#ffe4e6', '#e0e7ff', '#cffafe'];
  const v: Record<string, string> = {
    background: superficie,
    fontFamily: 'inherit',
    fontSize: '14px',
    // flowchart
    primaryColor: claro ? '#ede9fe' : '#3b2a5e',
    primaryTextColor: claro ? '#1c1917' : '#f3f0ff',
    primaryBorderColor: claro ? '#7c3aed' : '#a78bfa',
    secondaryColor: claro ? '#ccfbf1' : '#134e4a',
    secondaryTextColor: claro ? '#134e4a' : '#ccfbf1',
    secondaryBorderColor: claro ? '#0f766e' : '#2dd4bf',
    tertiaryColor: claro ? '#dbeafe' : '#1e3a8a',
    tertiaryTextColor: claro ? '#1e3a8a' : '#dbeafe',
    tertiaryBorderColor: claro ? '#1d4ed8' : '#60a5fa',
    lineColor: claro ? '#6d28d9' : '#a78bfa',
    textColor: claro ? '#1c1917' : '#ededec',
    edgeLabelBackground: superficie,
    clusterBkg: claro ? '#f5f3ff' : '#1f1a2e',
    clusterBorder: claro ? '#c4b5fd' : '#4c1d95',
    nodeBorder: claro ? '#7c3aed' : '#a78bfa',
    mainBkg: claro ? '#ede9fe' : '#3b2a5e',
  };
  ramas.forEach((color, i) => {
    v[`cScale${i}`] = color;
    v[`cScaleLabel${i}`] = textos[i];
    v[`cScalePeer${i}`] = claro ? '#ffffff' : superficie;
  });
  // La raíz del mapa mental (git0 en la implementación de Mermaid) y su texto.
  v.git0 = claro ? '#3d1974' : '#c0a3f0';
  v.gitBranchLabel0 = claro ? '#ffffff' : '#1c1917';
  return v;
}

/** El tema que hay pintado: lo escribe lib/theme.ts en `<html data-theme>`. */
function temaDelDom(): 'dark' | 'light' {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

type Estado =
  | { fase: 'cargando' }
  | { fase: 'listo'; svg: string }
  | { fase: 'fallo' };

export function Diagrama({ codigo, respaldo }: DiagramaProps) {
  const [estado, setEstado] = useState<Estado>({ fase: 'cargando' });
  const [tema, setTema] = useState<'dark' | 'light'>(temaDelDom);
  const [ampliado, setAmpliado] = useState(false);
  const contenedor = useRef<HTMLDivElement>(null);

  // El tema efectivo vive en el atributo `data-theme` del <html> (lo escribe
  // lib/theme.ts). Se observa para repintar el diagrama al cambiarlo.
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const observador = new MutationObserver(() => setTema(temaDelDom()));
    observador.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observador.disconnect();
  }, []);

  useEffect(() => {
    let vigente = true;
    setEstado({ fase: 'cargando' });
    (async () => {
      try {
        const { default: mermaid } = await import('mermaid');
        if (!vigente) return;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          // `base` y no `default`/`dark`: es el único tema que deja fijar la
          // paleta entera, incluida la de las ramas del mapa mental.
          theme: 'base',
          fontFamily: 'inherit',
          themeVariables: variablesDeTema(tema, colorDeToken('--surface', tema)),
          flowchart: { useMaxWidth: true, htmlLabels: false, curve: 'basis' },
        });
        contador += 1;
        const { svg } = await mermaid.render(`md-mermaid-${contador}`, codigo.trim());
        if (vigente) setEstado({ fase: 'listo', svg });
      } catch (err) {
        // Sintaxis inválida o Mermaid que no carga: ninguna de las dos es
        // motivo para perder el contenido, así que se dice en consola y se
        // pinta el respaldo.
        console.warn('No se pudo pintar el diagrama; se enseña como pasos.', err);
        if (vigente) setEstado({ fase: 'fallo' });
      }
    })();
    return () => {
      vigente = false;
    };
  }, [codigo, tema]);

  // Mermaid puede dejar nodos huérfanos en el <body> si el render se aborta a
  // mitad (su id temporal); se limpian al desmontar.
  useEffect(
    () => () => {
      for (const suelto of document.querySelectorAll('[id^="dmd-mermaid-"]')) suelto.remove();
    },
    [],
  );

  if (estado.fase === 'fallo') {
    return respaldo.length > 0 ? <PasosDeRespaldo pasos={respaldo} /> : <pre className="md-pre"><code>{codigo}</code></pre>;
  }
  if (estado.fase === 'cargando') {
    return (
      <div className="md-mermaid md-mermaid-cargando" role="status" aria-label="Preparando el diagrama">
        <span className="skeleton" />
      </div>
    );
  }
  return (
    <div className="md-mermaid-marco">
      <div
        ref={contenedor}
        className="md-mermaid"
        // El SVG lo genera Mermaid en modo estricto (sanea las etiquetas), y es
        // la única forma de insertar su salida.
        dangerouslySetInnerHTML={{ __html: estado.svg }}
      />
      {/* Ver en grande. Un diagrama de treinta nodos encajado en el ancho del
          mensaje es una miniatura ilegible; el visor lo enseña a su tamaño,
          con zoom y desplazamiento. */}
      <button
        type="button"
        className="md-mermaid-ampliar"
        onClick={() => setAmpliado(true)}
        title="Ver el diagrama en grande"
        aria-label="Ver el diagrama en grande"
      >
        <IconMaximize size={14} />
      </button>
      {ampliado && <VisorDiagrama svg={estado.svg} onClose={() => setAmpliado(false)} />}
    </div>
  );
}

/** Ancho y alto naturales del SVG de Mermaid, leídos de su `viewBox`. */
function tamanoDe(svg: string): { ancho: number; alto: number } {
  const m = /viewBox="[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)"/.exec(svg);
  const ancho = m ? Number(m[1]) : 800;
  const alto = m ? Number(m[2]) : 600;
  return { ancho: ancho > 0 ? ancho : 800, alto: alto > 0 ? alto : 600 };
}

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;

/**
 * El diagrama a pantalla completa: a su tamaño natural, con zoom (botones,
 * teclas + y -, rueda con Ctrl) y desplazamiento (scroll o arrastrando). Se
 * abre ajustado si cabe; si no cabe, a tamaño natural y se desplaza, porque
 * "ajustado" sería otra vez la miniatura que no se lee. Escape o la X cierran
 * y el foco vuelve al botón que lo abrió.
 */
function VisorDiagrama({ svg, onClose }: { svg: string; onClose: () => void }) {
  const natural = tamanoDe(svg);
  const lienzo = useRef<HTMLDivElement>(null);
  const cerrarRef = useRef<HTMLButtonElement>(null);
  const [zoom, setZoom] = useState(1);
  const arrastre = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);

  // Zoom inicial y foco. El scroll de la página se bloquea mientras está abierto.
  useEffect(() => {
    const previo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = lienzo.current;
    if (el) {
      const ajuste = Math.min((el.clientWidth - 32) / natural.ancho, (el.clientHeight - 32) / natural.alto);
      setZoom(ajuste >= 0.75 ? Math.min(ajuste, 1.5) : 1);
    }
    const desbordePrevio = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    cerrarRef.current?.focus();
    return () => {
      document.body.style.overflow = desbordePrevio;
      previo?.focus();
    };
  }, [natural.ancho, natural.alto]);

  const ajustar = () => {
    const el = lienzo.current;
    if (!el) return;
    setZoom(Math.max(ZOOM_MIN, Math.min((el.clientWidth - 32) / natural.ancho, (el.clientHeight - 32) / natural.alto)));
  };
  const cambiar = (factor: number) => setZoom((z) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z * factor)));

  const alTeclear = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    } else if (e.key === '+' || e.key === '=') cambiar(1.25);
    else if (e.key === '-') cambiar(0.8);
    else if (e.key === '0') ajustar();
  };
  const alRodar = (e: ReactWheelEvent<HTMLDivElement>) => {
    if (!e.ctrlKey && !e.metaKey) return; // la rueda sola desplaza, como en un mapa
    e.preventDefault();
    cambiar(e.deltaY < 0 ? 1.1 : 0.9);
  };
  const empezarArrastre = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = lienzo.current;
    if (!el || e.button !== 0) return;
    arrastre.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop };
    el.setPointerCapture(e.pointerId);
  };
  const mover = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = lienzo.current;
    const a = arrastre.current;
    if (!el || !a) return;
    el.scrollLeft = a.sl - (e.clientX - a.x);
    el.scrollTop = a.st - (e.clientY - a.y);
  };
  const soltar = () => {
    arrastre.current = null;
  };

  // En un portal sobre <body>: dentro del mensaje, cualquier antecesor con
  // transform o contain convierte el `position: fixed` en relativo a él, y el
  // visor salía recortado entre el sidebar y el panel de fuentes, con el
  // composer encima.
  return createPortal(
    <div className="visor" role="dialog" aria-modal="true" aria-label="Diagrama en grande" onKeyDown={alTeclear}>
      <div className="visor-barra">
        <button type="button" className="icon-btn" onClick={() => cambiar(0.8)} title="Alejar (tecla -)" aria-label="Alejar">
          <IconMinus size={15} />
        </button>
        <button type="button" className="visor-zoom" onClick={ajustar} title="Ajustar a la pantalla (tecla 0)">
          {Math.round(zoom * 100)} %
        </button>
        <button type="button" className="icon-btn" onClick={() => cambiar(1.25)} title="Acercar (tecla +)" aria-label="Acercar">
          <IconPlus size={15} />
        </button>
        <span className="visor-ayuda">Arrastra para moverte · Ctrl y rueda para el zoom</span>
        <button ref={cerrarRef} type="button" className="icon-btn" onClick={onClose} title="Cerrar (Esc)" aria-label="Cerrar el diagrama">
          <IconX size={16} />
        </button>
      </div>
      <div
        ref={lienzo}
        className="visor-lienzo"
        onWheel={alRodar}
        onPointerDown={empezarArrastre}
        onPointerMove={mover}
        onPointerUp={soltar}
        onPointerCancel={soltar}
      >
        <div
          className="visor-svg"
          style={{ width: natural.ancho * zoom, height: natural.alto * zoom }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
      <button type="button" className="visor-fondo" aria-label="Cerrar el diagrama" onClick={onClose} tabIndex={-1} />
    </div>,
    document.body,
  );
}

/** El diagrama como lista de pasos: el respaldo cuando Mermaid no está. */
function PasosDeRespaldo({ pasos }: { pasos: PasoFlujo[] }) {
  return (
    <ol className="md-flujo">
      {pasos.map((paso, k) => (
        <li key={k} className={`md-flujo-paso ${paso.rama ? 'md-flujo-rama' : ''}`}>
          <span className="md-flujo-marca" aria-hidden="true">
            {paso.rama ? '' : String(pasos.slice(0, k + 1).filter((x) => !x.rama).length)}
          </span>
          <span className="md-flujo-texto">{paso.texto}</span>
        </li>
      ))}
    </ol>
  );
}

/** Los pasos de respaldo de un código Mermaid: las etiquetas de sus nodos. */
export function respaldoDeMermaid(codigo: string): PasoFlujo[] {
  return parsearFlujo(etiquetasDeMermaid(codigo));
}

/**
 * Las etiquetas de los nodos de un flowchart, en orden y sin repetir.
 *
 * De `A[Medir la PA] --> B{Confirmada}` salen "Medir la PA" y "Confirmada". Es
 * lo que hace legible el respaldo: sin esto, la lista de pasos enseñaría la
 * sintaxis del grafo, que para quien lee una respuesta clínica no es contenido.
 */
export function etiquetasDeMermaid(codigo: string): string {
  const salida: string[] = [];
  const vistas = new Set<string>();
  const esMindmap = /^\s*mindmap\b/im.test(codigo);
  for (const linea of codigo.split('\n')) {
    const limpia = linea.trim();
    if (limpia === '' || /^(?:graph|flowchart|mindmap|sequenceDiagram|classDiagram|%%)/i.test(limpia)) continue;
    // Un mapa mental es una línea por nodo, con la forma opcional alrededor
    // del texto (root((tema)), id[texto]); sin forma, la línea ES el texto.
    if (esMindmap) {
      const forma = /^[\w-]*(?:\(\((.+)\)\)|\[(.+)\]|\((.+)\)|\{\{(.+)\}\}|\)(.+)\()$/.exec(limpia);
      const texto = (forma ? forma.slice(1).find((g) => g !== undefined) ?? limpia : limpia).trim();
      if (texto !== '' && !vistas.has(texto)) {
        vistas.add(texto);
        salida.push(texto);
      }
      continue;
    }
    // Etiquetas de nodo: [texto], (texto), {texto}, ([texto]), [[texto]].
    const etiquetas = [...limpia.matchAll(/[[({]+\s*"?([^\]})"|]+?)"?\s*[\])}]+/g)].map((m) => m[1].trim());
    // Etiqueta de la flecha: -->|sí| se lee como la condición de la rama.
    const condicion = /\|\s*([^|]+?)\s*\|/.exec(limpia);
    if (condicion && etiquetas.length) etiquetas[0] = `Si ${condicion[1]}: ${etiquetas[0]}`;
    for (const e of etiquetas) {
      if (e === '' || vistas.has(e)) continue;
      vistas.add(e);
      salida.push(e);
    }
  }
  return salida.join('\n');
}
