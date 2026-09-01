/**
 * Estado vacío del chat, al estilo de la home de Claude o ChatGPT: placa de
 * marca discreta, un saludo de una línea y, debajo del composer, una fila de
 * píldoras con etiquetas cortas.
 *
 * El composer no vive aquí: es el mismo de la conversación, al que el layout
 * de Chat coloca en el centro mientras no hay mensajes. Por eso esta pantalla
 * llega partida en dos piezas, una encima (WelcomeIntro) y otra debajo
 * (WelcomeSuggestions).
 *
 * Las píldoras RELLENAN el composer y le dan foco; nunca envían solas.
 */

interface SuggestionsProps {
  onPick: (question: string) => void;
  disabled: boolean;
}

/** Etiqueta corta visible en la píldora; `question` es lo que se escribe. */
const SUGGESTIONS: { label: string; question: string }[] = [
  {
    label: 'Rociadores Reliable',
    question:
      '¿Qué modelos de rociadores Reliable de respuesta rápida hay y qué factor K tienen?',
  },
  {
    label: 'Paneles Notifier',
    question:
      '¿Qué paneles de detección de incendios Notifier aparecen en los catálogos y cuántas zonas soportan?',
  },
  {
    label: 'Más barato por suplidor',
    question: 'Dame los productos más baratos de cada suplidor',
  },
  {
    label: 'Gabinetes Croker',
    question: '¿Qué gabinetes Croker existen y en qué medidas se ofrecen?',
  },
];

/** Placa y saludo: el bloque que queda justo encima del composer. */
export function WelcomeIntro() {
  return (
    <div className="welcome-intro">
      <div className="brand-plate welcome-plate" role="img" aria-label="FIREtech">
        <span className="brand-fire" aria-hidden="true">
          FIRE
        </span>
        <span className="brand-tech" aria-hidden="true">
          tech
        </span>
      </div>
      <h1 className="welcome-title">¿Qué buscamos hoy en los catálogos?</h1>
    </div>
  );
}

export function WelcomeSuggestions({ onPick, disabled }: SuggestionsProps) {
  return (
    <div className="suggestions">
      {SUGGESTIONS.map((s, i) => (
        <button
          key={s.label}
          type="button"
          className="suggestion"
          /* stagger corto: las píldoras entran tras el saludo */
          style={{ animationDelay: `${120 + i * 45}ms` }}
          title={s.question}
          onClick={() => onPick(s.question)}
          disabled={disabled}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
