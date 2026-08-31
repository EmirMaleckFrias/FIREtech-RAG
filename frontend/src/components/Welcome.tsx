import type { ReactNode } from 'react';
import { IconArchive, IconBell, IconDroplet, IconWrench } from './icons';

interface WelcomeProps {
  onAsk: (question: string) => void;
  disabled: boolean;
}

const EXAMPLES: { icon: ReactNode; question: string }[] = [
  {
    icon: <IconDroplet />,
    question:
      '¿Qué modelos de rociadores Reliable de respuesta rápida hay y qué factor K tienen?',
  },
  {
    icon: <IconBell />,
    question:
      '¿Qué paneles de detección de incendios Notifier aparecen en los catálogos y cuántas zonas soportan?',
  },
  {
    icon: <IconWrench />,
    question: '¿Qué equipos Croker hay disponibles para gabinetes contra incendio?',
  },
  {
    icon: <IconArchive />,
    question: '¿Qué gabinetes Aleum existen y en qué medidas se ofrecen?',
  },
];

export function Welcome({ onAsk, disabled }: WelcomeProps) {
  return (
    <div className="welcome-wrap">
      <div className="welcome">
        <div className="brand-plate brand-plate-lg welcome-logo" role="img" aria-label="FIREtech">
          <span className="brand-fire" aria-hidden="true">FIRE</span>
          <span className="brand-tech" aria-hidden="true">tech</span>
        </div>
        <h1>¿Qué buscamos en los catálogos?</h1>
        <p className="welcome-sub">
          Pregunta por precios, medidas y equipos de Aleum, Reliable, Croker y Notifier.
          Cada respuesta te dice de qué catálogo y página salió, para que cotices con
          confianza.
        </p>
        <div className="example-grid">
          {EXAMPLES.map((ex, i) => (
            <button
              key={ex.question}
              type="button"
              className="example-card"
              style={{ animationDelay: `${140 + i * 60}ms` }}
              onClick={() => onAsk(ex.question)}
              disabled={disabled}
            >
              <span className="example-icon" aria-hidden="true">
                {ex.icon}
              </span>
              <span className="example-text">{ex.question}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
