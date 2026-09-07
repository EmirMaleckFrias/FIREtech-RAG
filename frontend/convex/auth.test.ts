// Quién puede darse de alta. `correoPermitido` es la puerta del sistema: la
// comprueba `createOrUpdateUser` tanto al crear la cuenta como al entrar, así
// que un fallo aquí no es un mensaje feo, es una cuenta de fuera dentro del
// RAG.
//
// Las pruebas van a por las formas de colarse, no a por el camino feliz. Todas
// las trampas son variantes de la misma idea: que un dominio permitido
// aparezca en el correo sin ser el dominio del correo.
import { describe, expect, test } from "vitest";
import { correoPermitido } from "./auth";

const PERMITIDOS = ["airobotix.net", "alzheimerproject.com"];

describe("correoPermitido", () => {
  test("acepta cualquiera de los dominios permitidos, sin importar mayúsculas ni espacios", () => {
    expect(correoPermitido("ana@airobotix.net", PERMITIDOS)).toBe(true);
    expect(correoPermitido("maria@alzheimerproject.com", PERMITIDOS)).toBe(true);
    expect(correoPermitido("  Maria.Lopez@ALZHEIMERPROJECT.COM  ", PERMITIDOS)).toBe(true);
    // Y en la lista también se tolera el dominio escrito con arroba o con
    // espacios, que es como se pega en una variable de entorno.
    expect(correoPermitido("maria@alzheimerproject.com", [" @alzheimerproject.com "])).toBe(true);
  });

  test("un dominio parecido no cuela: la comprobación es del sufijo @dominio", () => {
    for (const correo of [
      "maria@alzheimerproject.com.atacante.com",
      "maria@sub.alzheimerproject.com",
      "maria@noalzheimerproject.com",
      "maria@alzheimerproject.com.mx",
      "maria@alzheimerproject.co",
      // Y el dominio viejo, que ya no vale.
      "maria@alzheimer.com",
      "ana@airobotix.net.atacante.com",
      "ana@notairobotix.net",
      // El dominio dentro del nombre, antes de la arroba.
      "alzheimerproject.com@atacante.com",
      "ana@airobotix.net@otro.com",
    ]) {
      expect(correoPermitido(correo, PERMITIDOS)).toBe(false);
    }
  });

  test("sin correo, sin lista, o con un dominio vacío dentro de la lista: no pasa nadie", () => {
    expect(correoPermitido("", PERMITIDOS)).toBe(false);
    expect(correoPermitido("   ", PERMITIDOS)).toBe(false);
    expect(correoPermitido("maria@alzheimerproject.com", [])).toBe(false);
    // El caso peligroso: un dominio vacío en la lista (una coma de más en la
    // variable de entorno) NO puede convertirse en "cualquier correo vale",
    // porque todo correo acaba en "@" + "".
    expect(correoPermitido("cualquiera@atacante.com", [""])).toBe(false);
    expect(correoPermitido("cualquiera@atacante.com", ["airobotix.net", "", "  "])).toBe(false);
  });

  test("sin parte local ('@airobotix.net' a secas) no pasa: cliente y servidor dicen lo mismo", () => {
    expect(correoPermitido("@airobotix.net", ["airobotix.net"])).toBe(false);
    expect(correoPermitido(" @airobotix.net ", ["airobotix.net"])).toBe(false);
    expect(correoPermitido("a@airobotix.net", ["airobotix.net"])).toBe(true);
  });

  test("un valor que no es texto se rechaza en vez de reventar", () => {
    expect(correoPermitido(undefined as unknown as string, PERMITIDOS)).toBe(false);
    expect(correoPermitido(null as unknown as string, PERMITIDOS)).toBe(false);
    expect(correoPermitido(42 as unknown as string, PERMITIDOS)).toBe(false);
  });
});
