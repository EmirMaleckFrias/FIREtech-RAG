// La forma del corpus, de un vistazo: cuántos documentos hay, cuánta evidencia
// suman y de qué está hecha.
//
// Es lo primero que se ve al abrir Documentos, y es deliberado: lo más
// característico del mundo de quien usa esto no es una lista de ficheros, es
// **su base de evidencia**, porque todo lo que el agente responde sale de aquí.
// Con 18 documentos y con 3 la lista se ve igual; esta banda no.
//
// La barra reparte por FRAGMENTOS y no por número de documentos: dos PDF de 50
// fragmentos sostienen más respuestas que diez notas de uno, y la barra tiene
// que decir eso. Solo cuenta lo que está listo, que es lo único que puede
// responder algo.
import { cifra, componer, resumir } from '../lib/biblioteca';
import type { DocumentInfo } from '../types';
import { IconAlert, IconSpinner } from './icons';

interface BandaCorpusProps {
  docs: DocumentInfo[];
  /** Qué hacer al pulsar el aviso de documentos en proceso o con error: los
   *  filtra en la vista de todos. Sin él, el aviso no es pulsable. */
  onVerEstado?: (estado: 'processing' | 'failed') => void;
}

export function BandaCorpus({ docs, onVerEstado }: BandaCorpusProps) {
  const r = resumir(docs);
  const tramos = componer(docs);
  const hayBarra = tramos.some((t) => t.fraccion > 0);

  return (
    <section className="banda" aria-label="Resumen de tus documentos">
      <p className="banda-cifras">
        <strong>{cifra(r.documentos)}</strong>{' '}
        {r.documentos === 1 ? 'documento' : 'documentos'}
        <span className="banda-sep" aria-hidden="true">
          ·
        </span>
        <strong>{cifra(r.fragmentos)}</strong>{' '}
        {r.fragmentos === 1 ? 'fragmento' : 'fragmentos'} de evidencia
      </p>

      {/* La barra solo aparece cuando hay algo listo que repartir: con todo en
          proceso, una barra vacía es más honesta que una repartida a ciegas, y
          con el corpus vacío no pinta nada. */}
      {hayBarra && (
        <>
          <div className="banda-barra" role="img" aria-label={etiquetaDeBarra(tramos)}>
            {tramos
              .filter((t) => t.fraccion > 0)
              .map((t) => (
                <span
                  key={t.formato.familia}
                  className={`banda-tramo banda-tramo-${t.formato.familia}`}
                  style={{ flexGrow: t.fraccion }}
                  title={`${t.formato.etiqueta}: ${cifra(t.fragmentos)} fragmentos`}
                />
              ))}
          </div>
          <ul className="banda-leyenda">
            {tramos.map((t) => (
              <li key={t.formato.familia}>
                <span className={`banda-punto banda-tramo-${t.formato.familia}`} aria-hidden="true" />
                {t.formato.etiqueta}
                <span className="banda-leyenda-n">{cifra(t.documentos)}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {(r.procesando > 0 || r.fallidos > 0) && (
        <p className="banda-avisos">
          {r.procesando > 0 && (
            <Aviso
              tono="proceso"
              onPulsar={onVerEstado ? () => onVerEstado('processing') : undefined}
            >
              <IconSpinner size={11} />
              <span className="shimmer-text">
                {cifra(r.procesando)} {r.procesando === 1 ? 'indexándose' : 'indexándose'}
              </span>
            </Aviso>
          )}
          {r.fallidos > 0 && (
            <Aviso tono="error" onPulsar={onVerEstado ? () => onVerEstado('failed') : undefined}>
              <IconAlert size={11} />
              {cifra(r.fallidos)} sin leer
            </Aviso>
          )}
        </p>
      )}
    </section>
  );
}

function Aviso({
  tono,
  onPulsar,
  children,
}: {
  tono: 'proceso' | 'error';
  onPulsar?: () => void;
  children: React.ReactNode;
}) {
  const clase = `banda-aviso banda-aviso-${tono}`;
  if (!onPulsar) return <span className={clase}>{children}</span>;
  return (
    <button type="button" className={clase} onClick={onPulsar}>
      {children}
    </button>
  );
}

/** La barra es decorativa para quien la ve, pero para quien la escucha tiene
 *  que decir lo mismo: de qué está hecho el corpus. */
function etiquetaDeBarra(tramos: ReturnType<typeof componer>): string {
  const partes = tramos
    .filter((t) => t.fragmentos > 0)
    .map((t) => `${t.formato.etiqueta}, ${Math.round(t.fraccion * 100)} %`);
  return `Composición por formato: ${partes.join('; ')}`;
}
