# Demostración sintética de integración — Jarvis ↔ Don Gastón

Fecha de cierre: 2026-11-17. Alcance aprobado expresamente por el usuario después
de [la evaluación contractual](JARVIS_INTEGRATION_READINESS.md). **Implementado y
verificado con consumidor sintético; interoperabilidad con runtime Jarvis real
todavía no verificada.** La Fase 1 sigue abierta; datos reales/FIN-01 productivo
no autorizados.

## Resultado demostrado

Una solicitud estructurada HTTPS autenticada registra **45.000 COP** en SQLite
sintética, categoría «Gasolina ficticia», fecha civil `2026-11-16`. La respuesta
contiene `minor:"4500000"`, COP, ID del gasto, categoría y fecha correctos.
Repetir conserva ese ID y una sola fila/gasto. Lookup recupera exclusivamente el
gasto por la intención original.

Se desconectó deliberadamente la respuesta después del commit: quedó una sola
fila y lookup recuperó el resultado tras reabrir ambos archivos. Otro proceso del
sistema operativo abrió la pareja persistida, levantó su fixture HTTPS efímera,
reintentó con los mismos IDs y obtuvo el mismo resultado sin duplicación.

Cambiar contenido, request_id o correlation_id con igual intención devuelve
conflicto. Credencial inválida, scope ajeno, permiso insuficiente o revocado no
permiten consultar/escribir datos ajenos. TLS rechaza CA y hostname incorrectos.
Todo es sintético; no se contactó Jarvis, Telegram, bancos ni IA.

## Implementación

- `jarvis-demo-contract.ts`: tipos, schemas estrictos, JSON acotado sin duplicados,
  serialización pública, correlación, códigos HTTP y traducción versionada de claves.
- `jarvis-demo-adapter.ts`: binding controlado de token/instancia/agente/sujeto/actor/
  permisos, autorización, reloj/deadline, record/lookup y errores sanitizados.
  Reutiliza `ExpenseService`; no contiene cálculo financiero alternativo.
- `jarvis-demo-journal.ts`: registro append-only de clave traducida y huella del
  request. Incluye request/correlation/input; excluye deadline. Es una base propia
  de metadatos sintéticos, **no la base de estado de Jarvis**.
- Fixtures de HTTPS y consumidor: bind 127.0.0.1/puerto efímero, CA y leaf generados
  localmente, TLS verificado, límites, sin redirects ni reintentos automáticos.
  Los listeners están bajo `tests/`, excluidos de build/arranque.

El perfil conserva exactamente dos capacidades v1.0: `finance.expense.record` y
`finance.expense.lookup`. Se actualizó [el contrato](../AGENT_PROTOCOL_DRAFT.md)
con el alcance aprobado, formatos, errores, seguridad y límites.

### Registro durable del adaptador

La clave es `jg1-` + SHA-256 del JSON de la tupla ordenada del ámbito wire:
instancia, sujeto, agente, capacidad, versión y clave externa. No se cambiaron
claves históricas ni la unicidad global del ledger financiero. Lookup reconstruye
la clave de record v1.0 a partir de write_intent_id y scope autorizado.

El journal se reserva antes del efecto. Un fallo puede dejar reserva sin gasto;
se permite reintentar explícitamente el mismo comando, no cambiar IDs/payload.
No se afirma atomicidad entre dos bases. La transacción financiera original sigue
uniendo hecho, huella, resultado y alertas.

La reapertura exige journal existente y válido; no se recrea silenciosamente.
Una base financiera con gasto confirmado y journal nuevo sin reserva se rechaza.
Para recuperar deben conservarse **ambos archivos como pareja coherente**. No se
implementó respaldo conjunto ni reconciliación con el journal durable de Jarvis.
Una edición coherente por alguien con control total del archivo no queda autenticada
por hashes sin firma.

## Ejecución reproducible

Desde Don Gastón, con Node 24 y herramientas locales ya instaladas:

```powershell
node --test tests/jarvis-demo-contract.test.ts tests/jarvis-demo-journal.test.ts tests/jarvis-synthetic-integration.test.ts
# Solo el recorrido básico HTTPS con registro, replay, lookup y reapertura:
node --test --test-name-pattern="45000 COP" tests/jarvis-synthetic-integration.test.ts
# Verificación completa:
npm.cmd run check
```

La fixture requiere OpenSSL local: en este Windows se utilizó el incluido en Git
(`C:/Program Files/Git/usr/bin/openssl.exe`); en otros entornos busca `openssl` en
PATH. No descarga dependencias ni instala certificados. Su ausencia causa fallo
explícito de la prueba, no una omisión ni desactivación de TLS.

Artefactos temporales sintéticos bajo `.cache/jarvis-synthetic-tests/` y
`.cache/jarvis-demo-journal/`, ignorados por Git. CA/leaf y tokens son nuevos por
ejecución; CA no instalada en truststore. El fixture de proceso conserva únicamente
material sintético en su directorio de prueba, sin imprimir credenciales. Los
archivos se conservan sin borrado automático; los servidores/conexiones se cierran.

## Evidencia realmente ejecutada

| Comando/ejecución | Resultado |
|---|---|
| Journal dirigido inicial | 5/5 |
| Primera suite dirigida de contrato/journal/HTTPS | 29/30; detectó respuesta incorrecta para lookup de categoría |
| Suite dirigida después de corrección y pruebas adicionales | 32/32 |
| `npm.cmd run format` | Salida 0 |
| `npm.cmd run check`: formato, lint, typecheck | Aprobados |
| `npm.cmd run check`: tests | **354/354**, sin fallos ni omitidas |
| `npm.cmd run check`: build | Aprobado |
| Verificación documental | 43 enlaces locales en 5 documentos válidos; whitespace correcto |
| `git diff --check` y diff de módulos financieros/manifiestos | Salida 0; sin cambios en dominio, aplicación, infraestructura financiera, bootstrap o dependencias |

La corrección del primer fallo devuelve found:false al encontrar una categoría,
manteniendo fallo cerrado ante gasto existente sin su reserva. Después se agregó
el test de plazo vencido tras reserva, incluido en la suite completa.
Son **321 pruebas financieras previas + 33 nuevas**: 9 de contrato, 5 de journal
y 19 de integración/consumidor. Se ejecutó una regresión completa al integrar los
archivos nuevos con las herramientas/build existentes; no se repitió después sin motivo.

Cobertura nueva: envelope/schema/hash exactos; límites y duplicados escapados;
gasto/lookup/replay; cambio de IDs/input; contexto y permisos; pérdida de respuesta;
rollback financiero con reserva previa; journal ausente/ajeno/alterado/cerrado;
serialización entre conexiones de journal; reemplazo indebido de metadatos;
reapertura en otro proceso; plazo vencido después de reserva; TLS/hostname y
respuesta con correlación errónea, redirect, compresión, duplicados, exceso o HTTP
incoherente. Estos últimos casos nunca provocan reintento automático del consumidor.

Logs: `.cache/jarvis-synthetic-targeted.log` (conserva fallo inicial),
`.cache/jarvis-synthetic-targeted-final.log`, `.cache/jarvis-synthetic-format.log`
y `.cache/jarvis-synthetic-check.log`. No se ejecutaron suites, runtime o CI de Jarvis.

## Archivos y coordinación

| Propietario de escritura | Archivos |
|---|---|
| `finance_domain`, luego coordinador | `src/interfaces/jarvis-demo-contract.ts`, `tests/jarvis-demo-contract.test.ts` |
| `test_engineer`, luego coordinador | `tests/jarvis-synthetic-integration.test.ts`, `tests/fixtures/jarvis-demo-certificates.ts`, `tests/fixtures/jarvis-demo-client.ts`, `tests/fixtures/jarvis-demo-https.ts` |
| Coordinador | `src/interfaces/jarvis-demo-adapter.ts`, `src/interfaces/jarvis-demo-journal.ts`, `tests/jarvis-demo-journal.test.ts`, `tests/fixtures/jarvis-demo-recovery-process.ts` |
| Coordinador, documentos | `docs/AGENT_PROTOCOL_DRAFT.md`, `README.md`, este informe y notas de estado en `MVP_READINESS.md` / `JARVIS_INTEGRATION_READINESS.md` |

Los especialistas iniciales se interrumpieron por límite de sesión. Al retomar se
comprobó que no quedaban agentes activos y el coordinador tomó sus archivos,
terminó integración y ejecutó todas las verificaciones. No hubo escritura simultánea.
Seguridad revisó únicamente este cambio en lectura, sin ejecutar pruebas ni leer
Jarvis. Sus observaciones sobre kind y deadline se corrigieron; el plazo posterior
a reserva quedó cubierto por test. No se certifica su sandbox efectivo por configuración.

No se alteraron módulos financieros, migraciones 001–010, paquete/dependencias,
bootstrap, política de red Jarvis o contrato de eventos. El ledger permanece en
SQLite v10; el journal del adaptador tiene versión independiente 1.

## Limitaciones y siguiente paso

- Consumidor **simulado** contra el contrato inspeccionado, no runtime Jarvis real.
  El próximo paso concreto es una prueba específica con Registry/Gateway/transporte
  reales de Jarvis bajo un alcance local autorizado, conservando repositorios y DB
  independientes. No habilitar Telegram ni FIN-01 para demostrarla.
- Binding y revocación son de fixture; el actor identifica delegación sintética.
  No hay configuración operativa, rotación persistente o identidad conversacional.
- No hay deadline que deshaga una transacción ya iniciada; un error de transporte
  puede seguir a commit. Lookup no concilia estados inciertos del orquestador.
- No hay backup coordinado de los dos archivos, rendimiento medido al límite,
  eventos, polling pending, descubrimiento automático ni servidor permanente.
- Journal de hasta 10000 reservas/8 MiB; JSON 64 KiB y dinero con límites existentes.
  El núcleo conserva todas sus restricciones anteriores y requiere autorización
  separada y controles operativos antes de cualquier uso real.

Esta demostración no completa toda la Fase 1 ni autoriza infraestructura o producción.
