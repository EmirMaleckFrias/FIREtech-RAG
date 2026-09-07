import { useState } from 'react';
import { aplicarTema, guardarTema, leerTema, type Tema } from '../lib/theme';
import {
  guardarPreferencias, PREFERENCIAS_INICIALES, usePreferencias,
  type Preferencias, type TamanoLectura,
} from '../lib/preferencias';
import { ROLE_LABEL, type UserRole } from '../types';
import {
  IconCheck, IconCircleHalf, IconLogout, IconPen, IconRefresh,
  IconSettings, IconShieldCheck,
} from './icons';

const TEMAS: { valor: Tema; etiqueta: string; ayuda: string }[] = [
  { valor: 'claro', etiqueta: 'Claro', ayuda: 'Una vista luminosa' },
  { valor: 'oscuro', etiqueta: 'Oscuro', ayuda: 'Menos luz en pantalla' },
  { valor: 'sistema', etiqueta: 'Automático', ayuda: 'Sigue a tu dispositivo' },
];
const TAMANOS: { valor: TamanoLectura; etiqueta: string }[] = [
  { valor: 'estandar', etiqueta: 'Estándar' },
  { valor: 'comodo', etiqueta: 'Cómodo' },
  { valor: 'grande', etiqueta: 'Grande' },
];

interface AccountSettingsProps {
  userEmail: string;
  role: UserRole | null;
  onSignOut: () => void;
}

export function AccountSettings({ userEmail, role, onSignOut }: AccountSettingsProps) {
  const [tema, setTema] = useState<Tema>(leerTema);
  const preferencias = usePreferencias();
  const [aviso, setAviso] = useState('');
  const [confirmarReset, setConfirmarReset] = useState(false);
  const iniciales = (userEmail.trim().slice(0, 2) || 'TU').toUpperCase();

  const cambiarPreferencia = (cambio: Partial<Preferencias>) => {
    const guardado = guardarPreferencias(cambio);
    setAviso(guardado ? 'Preferencia guardada en este navegador.' :
      'Cambio aplicado. El navegador no permite guardarlo para la próxima visita.');
    setConfirmarReset(false);
  };
  const cambiarTema = (nuevo: Tema) => {
    setTema(nuevo);
    guardarTema(nuevo);
    aplicarTema(nuevo);
    setAviso('Tema aplicado.');
    setConfirmarReset(false);
  };

  return (
    <div className="settings-tabpanel settings-scroll account-settings">
      <section className="settings-profile" aria-label="Tu cuenta">
        <div className="settings-profile-top">
          <span className="settings-avatar" aria-hidden="true">{iniciales}</span>
          <div className="settings-profile-copy">
            <span className="settings-eyebrow">TU ESPACIO DE INVESTIGACIÓN</span>
            <h3 title={userEmail}>{userEmail || 'Tu cuenta'}</h3>
            <span className="settings-profile-role">
              <IconShieldCheck size={13} />
              {role === null ? 'Cargando permisos…' : ROLE_LABEL[role]}
            </span>
          </div>
        </div>
        <div className="settings-profile-footer">
          <span className="settings-profile-dot" aria-hidden="true" />
          Proyecto Alzheimer <span aria-hidden="true">·</span> AI Robotix
        </div>
      </section>

      <section className="settings-card" aria-labelledby="settings-appearance-title">
        <div className="settings-section-heading">
          <span className="settings-section-icon"><IconCircleHalf size={18} /></span>
          <div><h3 id="settings-appearance-title">Hazlo tuyo</h3><p>Un espacio en el que dé gusto investigar.</p></div>
        </div>
        <fieldset className="settings-fieldset">
          <legend>Tema de la interfaz</legend>
          <div className="settings-themes">
            {TEMAS.map((t) => (
              <label key={t.valor} className="settings-theme">
                <input type="radio" name="settings-theme" value={t.valor}
                  checked={tema === t.valor} onChange={() => cambiarTema(t.valor)} />
                <span className="settings-theme-surface">
                  <span className={`settings-theme-preview settings-theme-${t.valor}`} aria-hidden="true">
                    <span className="settings-mini-sidebar"><i /><i /><i /></span>
                    <span className="settings-mini-chat"><i /><i /><i /><span /></span>
                    <span className="settings-theme-check"><IconCheck size={11} /></span>
                  </span>
                  <span className="settings-theme-name">{t.etiqueta}</span>
                  <span className="settings-theme-help">{t.ayuda}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="settings-fieldset settings-reading">
          <legend>Tamaño del texto del chat</legend>
          <div className="settings-size-options">
            {TAMANOS.map((t) => (
              <label key={t.valor}>
                <input type="radio" name="settings-reading" value={t.valor}
                  checked={preferencias.tamanoLectura === t.valor}
                  onChange={() => cambiarPreferencia({ tamanoLectura: t.valor })} />
                <span><span className={`settings-size-sample settings-size-${t.valor}`} aria-hidden="true">Aa</span>{t.etiqueta}</span>
              </label>
            ))}
          </div>
          <div className={`settings-reading-preview settings-reading-${preferencias.tamanoLectura}`}>
            <span className="settings-preview-label">VISTA PREVIA</span>
            <p>Más claridad para conectar ideas y explorar la evidencia.</p>
            <span className="settings-preview-source"><IconShieldCheck size={12} /> Tus fuentes, siempre a mano</span>
          </div>
        </fieldset>
      </section>

      <section className="settings-card" aria-labelledby="settings-workflow-title">
        <div className="settings-section-heading">
          <span className="settings-section-icon settings-icon-teal"><IconPen size={18} /></span>
          <div><h3 id="settings-workflow-title">A tu ritmo</h3><p>Pequeños ajustes para tu día a día.</p></div>
        </div>
        <label className="settings-toggle-row">
          <span><strong>Enviar con Enter</strong><small>{preferencias.enterEnvia
            ? 'Shift + Enter añade una nueva línea.'
            : 'Enter añade una línea. Ctrl / ⌘ + Enter envía.'}</small></span>
          <input type="checkbox" role="switch" checked={preferencias.enterEnvia}
            onChange={(e) => cambiarPreferencia({ enterEnvia: e.target.checked })} />
          <span className="settings-switch" aria-hidden="true" />
        </label>
        <label className="settings-toggle-row">
          <span><strong>Reducir animaciones</strong><small>Menos movimiento y desplazamientos suaves. También respetamos el ajuste de tu sistema.</small></span>
          <input type="checkbox" role="switch" checked={preferencias.reducirMovimiento}
            onChange={(e) => cambiarPreferencia({ reducirMovimiento: e.target.checked })} />
          <span className="settings-switch" aria-hidden="true" />
        </label>
      </section>

      <div className="settings-local-note">
        <IconSettings size={15} />
        <p>Preferencias de este navegador. No cambian tus documentos, las búsquedas ni las respuestas del agente.</p>
      </div>
      <p className="settings-save-status" role="status" aria-live="polite">{aviso}</p>
      <div className="settings-account-actions">
        {confirmarReset ? (
          <div className="settings-reset-confirm">
            <p>¿Restablecer el tema, el tamaño y los dos interruptores? Tus datos no se borrarán.</p>
            <div>
              <button type="button" className="settings-text-button" onClick={() => {
                cambiarTema('sistema');
                const guardado = guardarPreferencias({ ...PREFERENCIAS_INICIALES });
                setAviso(guardado ? 'Preferencias restablecidas.' : 'Restablecidas solo para esta visita: el almacenamiento está bloqueado.');
                setConfirmarReset(false);
              }}>Sí, restablecer</button>
              <button type="button" className="settings-text-button" onClick={() => setConfirmarReset(false)}>Cancelar</button>
            </div>
          </div>
        ) : (
          <button type="button" className="settings-text-button" onClick={() => setConfirmarReset(true)}>
            <IconRefresh size={14} /> Restablecer preferencias
          </button>
        )}
        <button type="button" className="settings-signout" onClick={onSignOut}>
          <IconLogout size={15} /> Cerrar sesión
        </button>
      </div>
    </div>
  );
}
