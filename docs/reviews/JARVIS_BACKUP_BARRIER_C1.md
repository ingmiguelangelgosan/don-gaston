# Fase 2F-C1 — Barrera persistente de escrituras

## Archivos modificados

| Repositorio y base local                                        | Archivos                                                                                                                                                                                  |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sir Jarvis · `db4ce29`, basado en `feat/don-gaston-integration` | `tests/maintenance-barrier.ts`, `tests/maintenance-barrier.test.ts`, `tests/fixtures/maintenance-coordinator.ts`                                                                          |
| Don Gastón · `174e55e`                                          | `tests/interop/jarvis-real-harness.mjs`, `tests/interop/jarvis-conversation-harness.mjs`, `tests/interop/jarvis-maintenance-barrier.test.mjs`, `docs/reviews/JARVIS_BACKUP_BARRIER_C1.md` |

Ambos cambios quedan en ramas locales `feat/2f-c1-maintenance-barrier`. La rama de Sir Jarvis depende del flujo de confirmación de `feat/don-gaston-integration`. Su base ya incluye el commit de egreso integrado en `origin/main` (`480bbf8`). No hubo commits, pushes, merges, despliegues ni acciones sobre el PR #11. Su estado remoto no se consultó.

## Escritores protegidos

| Escritor registrado | Rutas cercadas en el fixture                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conversation`      | Arranque de `conversation.sqlite`, preparación, consentimiento, cancelación, consultas mediante comandos, polling simulado y entregas simuladas. El journal de `jarvis.sqlite` controla reserva de acción, binding al consultar el offset y avance del offset. Los manejadores admitidos pueden terminar sus transiciones locales ya iniciadas.                                                                                                                            |
| `interop-runtime`   | Arranque y cierre de `jarvis.sqlite`, `adapter.sqlite` y `finance.sqlite`, incluidos inicialización y datos semilla. El Gateway comprueba admisión antes de reservar una ejecución y antes de cada despacho o consulta externa. El adaptador comprueba su propia admisión en la entrada compartida por HTTPS loopback y la llamada directa de prueba, antes de reservar o entrar al dominio. Las consultas de aplicación que escriben journal se someten al mismo control. |

## Escritores fuera del alcance

- Runtimes y loaders operativos, consumidores reales, jobs y CLI de mantenimiento, migraciones ejecutadas fuera del harness, procesos externos, clones y escrituras directas contra archivos SQLite. C1 se activa explícitamente al componer el fixture sintético.

## Mecanismo persistente implementado

- Una SQLite separada almacena una época UUID, la referencia opaca del coordinador y el instante de cierre. Solo una transacción `BEGIN IMMEDIATE` puede pasar la instalación de prueba a mantenimiento. Cada admisión abre el archivo vigente, valida formato, integridad, estado y época esperada y registra el trabajo antes del efecto. Ausencia, corrupción, inconsistencia, discrepancia de época o error de acceso bloquean la admisión. La inicialización explícita pertenece a un fixture nuevo.
- Los registros distinguen escritores y operaciones con identificador, fase e instantes de actividad. Los escritores se registran antes de abrir las bases y acusan cierre solo tras liberar sus recursos. La posesión del coordinador permite consultar operaciones activas y acuses. En el ensayo integrado se acreditó quietud después de terminar las operaciones y recibir el acuse de ambos escritores. Un fallo al cerrar conserva el registro pendiente.
- El cierre bloquea admisión, despacho, entregas y avance del polling nuevos. El trabajo local ya admitido queda visible hasta su finalización. Una entrega cercada después de un commit puede quedar `delivery-uncertain` según el journal existente. La barrera conserva el cierre al reconstruir componentes y tras la salida del coordinador. El tiempo transcurrido no concede posesión ni habilita escrituras.

## Pruebas ejecutadas

Windows, Node **24.22.3** portátil (`.cache/runtimes/node-v24.22.3-win-x64` en Don Gastón) y npm **11.19.1**, con datos artificiales y HTTPS loopback. Los comandos se ejecutaron desde la raíz del repositorio correspondiente. Prettier sobre los archivos de código modificados, `npm run lint`, `npm run typecheck`, `npm run build` y `git diff --check` pasaron en ambos repositorios.

| Repositorio | Comando y resultado                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sir Jarvis  | `node --test tests/maintenance-barrier.test.ts` · **5/5**. Ausencia, corrupción, inconsistencia, época obsoleta, operaciones en vuelo, acuse de cierre y fallo de cierre. Dos procesos disputan la posesión, se termina por fuerza al ganador y se adelanta siete días el reloj de prueba. La admisión y una nueva toma de posesión siguen denegadas.                                                                                                                                                                                                                                                                                      |
| Don Gastón  | `node --test tests/interop/jarvis-maintenance-barrier.test.mjs tests/interop/jarvis-real-gateway.test.mjs tests/interop/jarvis-conversation.test.mjs tests/interop/confirmation-flow.test.mjs` · **64/64**, 4 de C1 y 60 regresiones de los harnesses afectados. Rechazo de gasto, confirmación, polling, Gateway, entrada directa y consulta con journal. Cierre entre reserva y despacho. Terminación de una operación ya admitida con la misma intención, un solo gasto de **45.000 COP**, reserva del adaptador confirmada y cero entregas nuevas. Reconstrucción bloqueada y rechazo tras pérdida o corrupción de la barrera en vivo. |

## Limitaciones pendientes

- La evidencia cubre procesos y conexiones controlados por el harness en un solo host. Una pérdida del estado impide acreditar el cierre aunque se puedan detener localmente los componentes. Un escritor que termine abruptamente deja su registro pendiente. La persistencia se comprobó con caída de proceso, reinicio y fallos inyectados del archivo.
- C1 conserva estados de aplicación que puedan quedar inciertos. Captura coordinada, restauración, conciliación y autorización de reapertura quedan pendientes de sus respectivas fases.

## Riesgos para revisión con Astra

- Sustitución del archivo por una versión anterior de la misma época y duplicación de la instalación. La comprobación de época rechaza reemplazos de otra época. La continuidad frente a rollback de la misma época requiere identidad del almacenamiento y evidencia independiente del archivo.
- Cobertura de escritores ajenos al harness y evidencia de parada de un escritor caído. Revisar cómo acreditar la exclusión sin descartar el registro de una operación que pudo tener efecto, y cómo vincular los acuses a las cuatro fuentes exactas del corte.

## Condiciones para comenzar 2F-C2

- Revisar con Astra la continuidad de la barrera y el alcance de los escritores para el ensayo de captura. Mantener la dependencia explícita de `feat/don-gaston-integration` mientras el flujo de confirmación provenga de esa rama.
- Exigir posesión vigente, coincidencia de época, inventario de las cuatro fuentes sintéticas, cero operaciones activas y acuse de ambos escritores antes de iniciar una captura. Pérdida de evidencia, escritor sin cercar o drenaje incompleto impiden autorizar el corte.
