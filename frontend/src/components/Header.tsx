import { IconPanelLeft, IconPanelRight } from './icons';

interface HeaderProps {
  /** Título de la sesión activa (o null en el estado vacío). */
  title: string | null;
  sidebarOpen: boolean;
  sourcesOpen: boolean;
  onToggleSidebar: () => void;
  onToggleSources: () => void;
}

export function Header({
  title,
  sidebarOpen,
  sourcesOpen,
  onToggleSidebar,
  onToggleSources,
}: HeaderProps) {
  return (
    <header className="header">
      <div className="header-left">
        <button
          type="button"
          className="icon-btn"
          onClick={onToggleSidebar}
          title={sidebarOpen ? 'Ocultar conversaciones' : 'Mostrar conversaciones'}
          aria-label="Alternar panel de conversaciones"
          aria-pressed={sidebarOpen}
        >
          <IconPanelLeft />
        </button>
        {title !== null && <span className="header-title">{title}</span>}
      </div>

      <div className="header-right">
        <button
          type="button"
          className={`icon-btn ${sourcesOpen ? 'icon-btn-active' : ''}`}
          onClick={onToggleSources}
          title={sourcesOpen ? 'Ocultar fuentes' : 'Mostrar fuentes'}
          aria-label="Alternar panel de fuentes"
          aria-pressed={sourcesOpen}
        >
          <IconPanelRight />
        </button>
      </div>
    </header>
  );
}
