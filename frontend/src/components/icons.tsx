// Íconos SVG inline del producto: trazo lineal 1.75, currentColor.
// Sin dependencias; cada ícono es un componente pequeño y tipado.

import type { SVGProps } from 'react';

interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

function base(size: number, props: SVGProps<SVGSVGElement>): SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    focusable: false,
    ...props,
  };
}

export function IconPlus({ size = 16, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/** Panel izquierdo (toggle del sidebar). */
export function IconPanelLeft({ size = 18, ...props }: IconProps) {
  return (
    <svg {...base(size, { ...props, strokeWidth: 1.6 })}>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M9.5 4v16" />
    </svg>
  );
}

/** Panel derecho (toggle de fuentes). */
export function IconPanelRight({ size = 18, ...props }: IconProps) {
  return (
    <svg {...base(size, { ...props, strokeWidth: 1.6 })}>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M14.5 4v16" />
    </svg>
  );
}

export function IconArrowUp({ size = 16, ...props }: IconProps) {
  return (
    <svg {...base(size, { ...props, strokeWidth: 2.2 })}>
      <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />
    </svg>
  );
}

/** Cuadrado de "detener generación". */
export function IconStop({ size = 14, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      aria-hidden
      focusable={false}
      {...props}
    >
      <rect x="6" y="6" width="12" height="12" rx="2.5" />
    </svg>
  );
}

export function IconSearch({ size = 14, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.8-3.8" />
    </svg>
  );
}

/** Chevron simple hacia abajo (rota vía CSS al expandir). */
export function IconChevronDown({ size = 14, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function IconDocument({ size = 15, ...props }: IconProps) {
  return (
    <svg {...base(size, { ...props, strokeWidth: 1.6 })}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

export function IconThumbUp({ size = 16, filled = false, ...props }: IconProps & { filled?: boolean }) {
  return (
    <svg {...base(size, { ...props, strokeWidth: 1.6, fill: filled ? 'currentColor' : 'none' })}>
      <path d="M7 10.5v9.5H4.5a1.5 1.5 0 0 1-1.5-1.5v-6.5a1.5 1.5 0 0 1 1.5-1.5H7Zm0 0 4-7a2.4 2.4 0 0 1 2.4 2.4V9h5.1a2 2 0 0 1 2 2.4l-1.2 6.5a2 2 0 0 1-2 1.6H7" />
    </svg>
  );
}

export function IconThumbDown({ size = 16, filled = false, ...props }: IconProps & { filled?: boolean }) {
  return (
    <svg {...base(size, { ...props, strokeWidth: 1.6, fill: filled ? 'currentColor' : 'none' })}>
      <path d="M17 13.5V4h2.5A1.5 1.5 0 0 1 21 5.5V12a1.5 1.5 0 0 1-1.5 1.5H17Zm0 0-4 7a2.4 2.4 0 0 1-2.4-2.4V15H5.5a2 2 0 0 1-2-2.4l1.2-6.5a2 2 0 0 1 2-1.6H17" />
    </svg>
  );
}

export function IconAlert({ size = 15, ...props }: IconProps) {
  return (
    <svg {...base(size, { ...props, strokeWidth: 1.6 })}>
      <path d="M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}

/** Spinner fino (la animación de giro vive en CSS: clase .spin). */
export function IconSpinner({ size = 14, ...props }: IconProps) {
  return (
    <svg {...base(size, { ...props, strokeWidth: 2, className: `spin ${props.className ?? ''}` })}>
      <path d="M21 12a9 9 0 1 1-6.2-8.56" />
    </svg>
  );
}

export function IconX({ size = 16, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

/** Dos rectángulos superpuestos (copiar al portapapeles). */
export function IconCopy({ size = 14, ...props }: IconProps) {
  return (
    <svg {...base(size, { ...props, strokeWidth: 1.8 })}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5.5 15H4.8A1.8 1.8 0 0 1 3 13.2V4.8A1.8 1.8 0 0 1 4.8 3h8.4A1.8 1.8 0 0 1 15 4.8v.7" />
    </svg>
  );
}

export function IconCheck({ size = 14, ...props }: IconProps) {
  return (
    <svg {...base(size, { ...props, strokeWidth: 2.2 })}>
      <path d="m5 12.5 4.7 4.7L19 7.5" />
    </svg>
  );
}

/** Flecha hacia arriba saliendo de una bandeja (subir documento). */
export function IconUpload({ size = 18, ...props }: IconProps) {
  return (
    <svg {...base(size, { ...props, strokeWidth: 1.6 })}>
      <path d="M12 15V4M7 8.5 12 3.5l5 5" />
      <path d="M4 15v3a2.5 2.5 0 0 0 2.5 2.5h11A2.5 2.5 0 0 0 20 18v-3" />
    </svg>
  );
}

export function IconTrash({ size = 15, ...props }: IconProps) {
  return (
    <svg {...base(size, { ...props, strokeWidth: 1.6 })}>
      <path d="M4 6.5h16" />
      <path d="M9 6.5V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5" />
      <path d="M18.5 6.5 17.6 19a2 2 0 0 1-2 1.9H8.4a2 2 0 0 1-2-1.9L5.5 6.5" />
      <path d="M10 10.5v6M14 10.5v6" />
    </svg>
  );
}

/** Candado cerrado (catálogos base, no borrables). */
export function IconLock({ size = 14, ...props }: IconProps) {
  return (
    <svg {...base(size, { ...props, strokeWidth: 1.6 })}>
      <rect x="4.5" y="10.5" width="15" height="9.5" rx="2.5" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

/** Engranaje de ajustes: corona de seis dientes y eje central. */
export function IconSettings({ size = 15, ...props }: IconProps) {
  return (
    <svg {...base(size, { ...props, strokeWidth: 1.6 })}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.6v2.6M12 18.8v2.6M4.9 4.9l1.9 1.9M17.2 17.2l1.9 1.9M2.6 12h2.6M18.8 12h2.6M4.9 19.1l1.9-1.9M17.2 6.8l1.9-1.9" />
    </svg>
  );
}

/** Una persona (fila de cuenta en el panel de usuarios). */
export function IconUser({ size = 15, ...props }: IconProps) {
  return (
    <svg {...base(size, { ...props, strokeWidth: 1.6 })}>
      <circle cx="12" cy="8" r="3.6" />
      <path d="M5 20v-1.2A4.8 4.8 0 0 1 9.8 14h4.4a4.8 4.8 0 0 1 4.8 4.8V20" />
    </svg>
  );
}

/** Dos personas (gestión de usuarios): una en primer plano y otra detrás. */
export function IconUsers({ size = 15, ...props }: IconProps) {
  return (
    <svg {...base(size, { ...props, strokeWidth: 1.6 })}>
      <circle cx="9.5" cy="8" r="3.5" />
      <path d="M3.5 20v-1a4.5 4.5 0 0 1 4.5-4.5h3a4.5 4.5 0 0 1 4.5 4.5v1" />
      <path d="M16.5 5.2a3.5 3.5 0 0 1 0 6.6" />
      <path d="M18 14.7a4.5 4.5 0 0 1 2.5 4V20" />
    </svg>
  );
}

/** Puerta con flecha saliendo (cerrar sesión). */
export function IconLogout({ size = 15, ...props }: IconProps) {
  return (
    <svg {...base(size, { ...props, strokeWidth: 1.6 })}>
      <path d="M10 20.5H6.5A2.5 2.5 0 0 1 4 18V6a2.5 2.5 0 0 1 2.5-2.5H10" />
      <path d="m16 16.5 4.5-4.5L16 7.5" />
      <path d="M20.5 12H9.5" />
    </svg>
  );
}

/* ---- íconos de las tarjetas de bienvenida (trazo lineal) ---- */

export function IconDroplet({ size = 18, ...props }: IconProps) {
  return (
    <svg {...base(size, { ...props, strokeWidth: 1.6 })}>
      <path d="M12 2.7 6.9 9.2a6.5 6.5 0 1 0 10.2 0Z" />
      <path d="M9.5 14.5a2.5 2.5 0 0 0 2 2.4" />
    </svg>
  );
}

export function IconBell({ size = 18, ...props }: IconProps) {
  return (
    <svg {...base(size, { ...props, strokeWidth: 1.6 })}>
      <path d="M6 8a6 6 0 0 1 12 0c0 4 1.5 5.5 2 6.5H4c.5-1 2-2.5 2-6.5Z" />
      <path d="M10 18.5a2.1 2.1 0 0 0 4 0" />
    </svg>
  );
}

export function IconWrench({ size = 18, ...props }: IconProps) {
  return (
    <svg {...base(size, { ...props, strokeWidth: 1.6 })}>
      <path d="M14.7 6.3a4.5 4.5 0 0 0-6 5.6L3 17.6a2 2 0 1 0 2.8 2.8l5.7-5.7a4.5 4.5 0 0 0 5.6-6L14 11.8l-2.5-2.5Z" />
    </svg>
  );
}

export function IconArchive({ size = 18, ...props }: IconProps) {
  return (
    <svg {...base(size, { ...props, strokeWidth: 1.6 })}>
      <rect x="3" y="4" width="18" height="5" rx="1.2" />
      <path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4" />
    </svg>
  );
}
