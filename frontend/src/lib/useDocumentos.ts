// El estado y las acciones de la lista de documentos, en un sitio: la lista
// suscrita, la escala de la barra de peso, borrar, reindexar, y los estados
// efímeros de cada fila (borrando, reindexando, confirmación abierta, detalle
// del error, el destello al pasar a "listo").
//
// Existe porque ahora hay DOS superficies que enseñan documentos: el panel
// lateral y la vista de todos (components/Biblioteca.tsx). Duplicar borrar y
// reindexar en las dos era garantizar que una de las copias se quedase atrás,
// y son justo las acciones que no conviene tener a medias.
//
// La suscripción es la misma query en las dos superficies: Convex la comparte,
// así que abrir la vista de todos no pide los documentos otra vez.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { avisarSiEsFatal } from './auth';
import { maxFragmentos } from './biblioteca';
import { mensajeDeError } from './errores';
import type { DocumentInfo, DocumentStatus } from '../types';

/** Cuánto dura el destello verde de un documento que acaba de quedar listo. */
export const DESTELLO_MS = 1_800;

/** Lo que el frontend lee de un registro de `documents`. Tipo estructural,
 *  para que un campo que la query añada no rompa nada. */
interface DocumentoDoc {
  _id: Id<'documents'>;
  fileName: string;
  pages?: number;
  chunks?: number;
  status?: string;
  error?: string | null;
  ingestadoEn?: number;
  _creationTime?: number;
  origen?: string | null;
  sha256?: string | null;
  titulo?: string | null;
  citation?: string | null;
}

export function normalizeDocumento(d: DocumentoDoc): DocumentInfo {
  const status: DocumentStatus =
    d.status === 'processing' || d.status === 'failed' ? d.status : 'ready';
  return {
    id: d._id,
    fileName: d.fileName,
    pages: typeof d.pages === 'number' ? d.pages : 0,
    chunks: typeof d.chunks === 'number' ? d.chunks : 0,
    status,
    error: typeof d.error === 'string' && d.error !== '' ? d.error : null,
    ingestadoEn:
      typeof d.ingestadoEn === 'number'
        ? d.ingestadoEn
        : typeof d._creationTime === 'number'
          ? d._creationTime
          : 0,
    origen: d.origen === 'notion' || d.origen === 'subida' ? d.origen : null,
    sha256: typeof d.sha256 === 'string' && d.sha256 !== '' ? d.sha256 : null,
    titulo: typeof d.titulo === 'string' && d.titulo.trim() !== '' ? d.titulo : null,
    citation: typeof d.citation === 'string' && d.citation.trim() !== '' ? d.citation : null,
  };
}

export interface Documentos {
  /** null mientras la suscripción no ha entregado nada. */
  docs: DocumentInfo[] | null;
  /** Fragmentos del documento que más aporta: la escala de la barra de peso. */
  maximo: number;
  borrando: Set<string>;
  reindexando: Set<string>;
  confirmando: Id<'documents'> | null;
  erroresAbiertos: Set<string>;
  /** Mensaje de error por fila, de una acción que falló. */
  erroresDeFila: Record<string, string>;
  /** Los que acaban de pasar a "listo": destellan una vez. */
  recienListos: Set<string>;
  confirmar: (id: Id<'documents'> | null) => void;
  borrar: (doc: DocumentInfo) => Promise<void>;
  reindexar: (doc: DocumentInfo) => Promise<void>;
  alternarError: (id: string) => void;
}

/** Suscribe la lista y expone las acciones. `activo` en false pone la query en
 *  `skip`: sin nadie mirando documentos, no hay suscripción abierta. */
export function useDocumentos(activo: boolean): Documentos {
  const consulta = useQuery(api.documentos.listar, activo ? {} : 'skip');
  const mutBorrar = useMutation(api.documentos.borrar);
  const mutReindexar = useMutation(api.documentos.reindexar);

  const docs = useMemo<DocumentInfo[] | null>(
    () =>
      consulta === undefined
        ? null
        : consulta.map(normalizeDocumento).sort((a, b) => b.ingestadoEn - a.ingestadoEn),
    [consulta],
  );
  const maximo = useMemo(() => maxFragmentos(docs ?? []), [docs]);

  const [borrando, setBorrando] = useState<Set<string>>(new Set());
  const [reindexando, setReindexando] = useState<Set<string>>(new Set());
  const [confirmando, setConfirmando] = useState<Id<'documents'> | null>(null);
  const [erroresAbiertos, setErroresAbiertos] = useState<Set<string>>(new Set());
  const [erroresDeFila, setErroresDeFila] = useState<Record<string, string>>({});
  const [recienListos, setRecienListos] = useState<Set<string>>(new Set());

  const previos = useRef<DocumentInfo[] | null>(null);
  const relojes = useRef<number[]>([]);

  // Limpieza al desmontar: los temporizadores del destello.
  useEffect(
    () => () => {
      for (const t of relojes.current) window.clearTimeout(t);
    },
    [],
  );

  // Quién acaba de pasar a "listo", comparando con la entrega anterior de la
  // suscripción. Es la única forma de saberlo: la query no dice qué cambió.
  useEffect(() => {
    if (docs === null) return;
    const antes = previos.current;
    previos.current = docs;
    if (antes === null) return;
    const estabaEnProceso = new Set(
      antes.filter((d) => d.status === 'processing').map((d) => String(d.id)),
    );
    const nuevos = docs
      .filter((d) => d.status === 'ready' && estabaEnProceso.has(String(d.id)))
      .map((d) => String(d.id));
    if (nuevos.length === 0) return;
    setRecienListos((s) => new Set([...s, ...nuevos]));
    const t = window.setTimeout(() => {
      setRecienListos((s) => {
        const next = new Set(s);
        for (const id of nuevos) next.delete(id);
        return next;
      });
    }, DESTELLO_MS);
    relojes.current.push(t);
  }, [docs]);

  const olvidarError = useCallback((id: string) => {
    setErroresDeFila((errs) => {
      if (!(id in errs)) return errs;
      const next = { ...errs };
      delete next[id];
      return next;
    });
  }, []);

  const borrar = useCallback(
    async (doc: DocumentInfo) => {
      setConfirmando(null);
      olvidarError(String(doc.id));
      setBorrando((s) => new Set(s).add(String(doc.id)));
      try {
        await mutBorrar({ documentId: doc.id });
        // La ficha desaparece con la siguiente entrega de la suscripción, que
        // llega antes de que esta promesa se resuelva.
      } catch (err) {
        if (!avisarSiEsFatal(err)) {
          setErroresDeFila((errs) => ({
            ...errs,
            [String(doc.id)]: mensajeDeError(err, 'No se pudo quitar el documento.'),
          }));
        }
      } finally {
        setBorrando((s) => {
          const next = new Set(s);
          next.delete(String(doc.id));
          return next;
        });
      }
    },
    [mutBorrar, olvidarError],
  );

  const reindexar = useCallback(
    async (doc: DocumentInfo) => {
      olvidarError(String(doc.id));
      setReindexando((s) => new Set(s).add(String(doc.id)));
      try {
        await mutReindexar({ documentId: doc.id });
      } catch (err) {
        if (!avisarSiEsFatal(err)) {
          setErroresDeFila((errs) => ({
            ...errs,
            [String(doc.id)]: mensajeDeError(err, 'No se pudo volver a indexar el documento.'),
          }));
        }
      } finally {
        setReindexando((s) => {
          const next = new Set(s);
          next.delete(String(doc.id));
          return next;
        });
      }
    },
    [mutReindexar, olvidarError],
  );

  const alternarError = useCallback((id: string) => {
    setErroresAbiertos((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return {
    docs,
    maximo,
    borrando,
    reindexando,
    confirmando,
    erroresAbiertos,
    erroresDeFila,
    recienListos,
    confirmar: setConfirmando,
    borrar,
    reindexar,
    alternarError,
  };
}
