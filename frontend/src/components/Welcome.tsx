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
    label: 'Buscar evidencia',
    question: '¿Qué evidencia existe sobre los mecanismos de inflamación en Alzheimer?',
  },
  {
    label: 'Resumir un tema',
    question: 'Resume los hallazgos principales sobre biomarcadores de Alzheimer.',
  },
  {
    label: 'Comparar fuentes',
    question: 'Compara las conclusiones de las fuentes sobre tratamientos actuales.',
  },
  {
    label: 'Detectar diferencias',
    question: '¿Qué diferencias importantes hay entre los estudios indexados?',
  },
];

/** Placa y saludo: el bloque que queda justo encima del composer. */
export function WelcomeIntro() {
  return (
    <div className="welcome-intro">
      <div className="welcome-logos" aria-label="AI ROBOTIX y Alzheimer Project">
        <img className="brand-logo brand-logo-ai" src="/ai-robotix.svg" alt="AI ROBOTIX" />
        <img className="brand-logo brand-logo-project" src="/alzheimer-project.svg" alt="Alzheimer Project" />
      </div>
      <h1 className="welcome-title">¿Qué investigamos hoy?</h1>
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
