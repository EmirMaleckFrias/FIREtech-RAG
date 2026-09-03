// Informe de atribución de una respuesta, plegable.
//
// Decisiones:
// - **Lo que se resume arriba es el fallo, no el acierto.** Si todo está
//   sostenido, una línea sobria basta; lo que tiene que salirte a la cara es
//   una cita que no resuelve o una afirmación que su fragmento no sostiene.
//   Un panel que celebre "3/3 verificadas" enseña a ignorarlo.
// - **`sin_verificar` se pinta como aviso, nunca como aprobado.** Es el estado
//   por defecto del backend ante un fallo del modelo o un tope alcanzado, así
//   que pintarlo en verde sería justo la garantía falsa que el verificador
//   existe para evitar.
// - **Cerrado por defecto salvo que haya algo que mirar.** Quien lee una
//   respuesta limpia no debería tener que cerrar un panel; quien lee una con
//   problemas no debería tener que buscarlos.
// - No hay porcentaje grande de "fidelidad" en la cabecera a propósito: una
//   cifra sobre 3 afirmaciones invita a compararla entre respuestas como si
//   fuera una nota, y no lo es.
import { useState } from 'react';
import type { Afirmacion, Veredicto, Verificacion } from '../types';
import { IconAlert, IconCheck, IconChevronDown } from './icons';

interface VerificationBadgeProps {
  informe: Verificacion;
}

/** Cómo se presenta cada veredicto. `grave` decide si abre el panel solo. */
const ESTILO: Record<Veredicto, { etiqueta: string; clase: string; grave: boolean }> = {
  sostenida: { etiqueta: 'Sostenida', clase: 'verif-ok', grave: false },
  parcial: { etiqueta: 'Parcial', clase: 'verif-parcial', grave: true },
  no_sostenida: { etiqueta: 'No sostenida', clase: 'verif-mal', grave: true },
  cita_no_resuelve: { etiqueta: 'Cita sin fuente', clase: 'verif-mal', grave: true },
  sin_verificar: { etiqueta: 'Sin comprobar', clase: 'verif-aviso', grave: true },
};

function cuenta(afirmaciones: Afirmacion[], veredicto: Veredicto): number {
  return afirmaciones.filter((a) => a.veredicto === veredicto).length;
}

export function VerificationBadge({ informe }: VerificationBadgeProps) {
  const { afirmaciones } = informe;
  const problemas = afirmaciones.filter((a) => ESTILO[a.veredicto].grave);
  // Abre solo si hay algo que mirar: lo limpio no interrumpe.
  const [abierto, setAbierto] = useState(problemas.length > 0);

  // Sin afirmaciones citadas no hay atribución que auditar (una abstención
  // legítima no lleva citas). Decirlo es más honesto que no pintar nada.
  if (afirmaciones.length === 0) {
    return (
      <div className="verif verif-vacia">
        <span className="verif-resumen">{informe.nota || 'Sin citas que verificar'}</span>
      </div>
    );
  }

  const sostenidas = cuenta(afirmaciones, 'sostenida');
  const limpio = problemas.length === 0;

  const resumen = limpio
    ? `${sostenidas} de ${afirmaciones.length} afirmaciones respaldadas por su fuente`
    : [
        cuenta(afirmaciones, 'cita_no_resuelve') > 0 &&
          `${cuenta(afirmaciones, 'cita_no_resuelve')} cita(s) sin fuente recuperada`,
        cuenta(afirmaciones, 'no_sostenida') > 0 &&
          `${cuenta(afirmaciones, 'no_sostenida')} no sostenida(s)`,
        cuenta(afirmaciones, 'parcial') > 0 && `${cuenta(afirmaciones, 'parcial')} parcial(es)`,
        cuenta(afirmaciones, 'sin_verificar') > 0 &&
          `${cuenta(afirmaciones, 'sin_verificar')} sin comprobar`,
      ]
        .filter(Boolean)
        .join(' · ');

  return (
    <div className={`verif ${limpio ? 'verif-limpio' : 'verif-con-avisos'}`}>
      <button
        type="button"
        className="verif-cabecera"
        aria-expanded={abierto}
        onClick={() => setAbierto((v) => !v)}
      >
        {limpio ? <IconCheck size={13} /> : <IconAlert size={13} />}
        <span className="verif-resumen">{resumen}</span>
        <span className={`verif-flecha ${abierto ? 'verif-flecha-abierta' : ''}`}>
          <IconChevronDown size={12} />
        </span>
      </button>

      {!informe.ok && informe.nota && <p className="verif-nota">{informe.nota}</p>}

      {abierto && (
        <ul className="verif-lista">
          {afirmaciones.map((a, i) => {
            const estilo = ESTILO[a.veredicto];
            return (
              <li key={i} className={`verif-item ${estilo.clase}`}>
                <span className="verif-veredicto">{estilo.etiqueta}</span>
                <span className="verif-texto">
                  {a.texto}
                  <span className="verif-cita">{a.cita}</span>
                  {a.motivo && <span className="verif-motivo">{a.motivo}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
