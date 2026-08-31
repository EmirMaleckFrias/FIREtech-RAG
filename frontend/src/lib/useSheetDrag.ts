// Swipe-down para cerrar un bottom sheet arrastrando su asa (pointer events).
//
// Solo actúa cuando el panel está en modo bottom sheet (≤600px, ver
// styles.css §13b). Durante el arrastre el panel sigue al dedo (solo hacia
// abajo); al soltar, si superó el umbral se cierra,el transform inline se
// retira en el siguiente frame para que la transición CSS anime desde la
// posición arrastrada, , y si no, vuelve a su sitio con la transición normal.

import { useEffect, useRef, type RefObject } from 'react';

const CLOSE_THRESHOLD_PX = 90;
const SHEET_MODE_QUERY = '(max-width: 600px)';

export function useSheetDrag(
  panelRef: RefObject<HTMLElement | null>,
  grabberRef: RefObject<HTMLElement | null>,
  onClose: () => void,
): void {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const grabber = grabberRef.current;
    const panel = panelRef.current;
    if (!grabber || !panel) return;

    let dragging = false;
    let startY = 0;

    const settle = () => {
      panel.style.transition = '';
      panel.style.transform = '';
    };

    const onPointerDown = (e: PointerEvent) => {
      if (!window.matchMedia(SHEET_MODE_QUERY).matches) return;
      if (!e.isPrimary) return;
      dragging = true;
      startY = e.clientY;
      grabber.setPointerCapture(e.pointerId);
      panel.style.transition = 'none';
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dy = Math.max(0, e.clientY - startY);
      panel.style.transform = `translateY(${dy}px)`;
    };

    const finish = (e: PointerEvent, cancelled: boolean) => {
      if (!dragging) return;
      dragging = false;
      const dy = Math.max(0, e.clientY - startY);
      if (!cancelled && dy > CLOSE_THRESHOLD_PX) {
        onCloseRef.current();
        // El estado "cerrado" ya está aplicado: al retirar el transform
        // inline un frame después, la transición corre desde la posición
        // actual del dedo hasta translateY(100%).
        requestAnimationFrame(settle);
      } else {
        settle(); // vuelve a su sitio con la transición de la hoja
      }
    };

    const onPointerUp = (e: PointerEvent) => finish(e, false);
    const onPointerCancel = (e: PointerEvent) => finish(e, true);

    grabber.addEventListener('pointerdown', onPointerDown);
    grabber.addEventListener('pointermove', onPointerMove);
    grabber.addEventListener('pointerup', onPointerUp);
    grabber.addEventListener('pointercancel', onPointerCancel);
    return () => {
      grabber.removeEventListener('pointerdown', onPointerDown);
      grabber.removeEventListener('pointermove', onPointerMove);
      grabber.removeEventListener('pointerup', onPointerUp);
      grabber.removeEventListener('pointercancel', onPointerCancel);
      settle();
    };
  }, [panelRef, grabberRef]);
}
