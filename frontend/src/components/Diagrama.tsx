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
import { useEffect, useRef, useState } from 'react';
import { parsearFlujo, type PasoFlujo } from '../lib/markdown';

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
          theme: tema === 'dark' ? 'dark' : 'default',
          fontFamily: 'inherit',
          // El fondo de las etiquetas de las flechas ("se confirma") lo pone
          // Mermaid en un gris claro fijo, que en oscuro queda como una
          // pegatina; se toma del propio tema de la aplicación.
          themeVariables: { edgeLabelBackground: colorDeToken('--surface', tema) },
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
    <div
      ref={contenedor}
      className="md-mermaid"
      // El SVG lo genera Mermaid en modo estricto (sanea las etiquetas), y es
      // la única forma de insertar su salida.
      dangerouslySetInnerHTML={{ __html: estado.svg }}
    />
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
  for (const linea of codigo.split('\n')) {
    const limpia = linea.trim();
    if (limpia === '' || /^(?:graph|flowchart|sequenceDiagram|classDiagram|%%)/i.test(limpia)) continue;
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
