# Fase 2A — interoperabilidad local con componentes reales de Jarvis

Fecha: 2026-11-17. Alcance sintético aprobado explícitamente. **Demostración
funcional verificada con clases reales**, sin arrancar ni modificar el Jarvis
operativo. No se declara compatibilidad soportada del entorno: Node instalado
24.19.0 satisface Don Gastón, pero Jarvis declara `>=24.22.1 <25`. Debe repetirse
en una versión admitida por ambos. No se actualizó el runtime del equipo.

## Procedencia e independencia

- Jarvis: checkout local `D:/Documentos/sir-jarvis`, paquete `sir-jarvis` 0.1.0,
  HEAD `c015c4e02908676fa8f87fc7bf524580169bb578`. Se reinspeccionó código actual,
  no se dedujo compatibilidad del informe anterior. Las rutas contractuales,
  estado durable, migración y manifiestos inspeccionados no tienen diferencias
  frente a HEAD.
- Don Gastón: base de trabajo `7e87dd98b0a4e5b84ff6b452e2bc39516a31b2f9`.
  SQLite financiera v10 y journal del adaptador v1 permanecen intactos.
- Importaciones reales: `InMemoryAgentRegistry`, `CapabilitySchemaCatalog`,
  `DurableAgentGateway` (compone `InMemoryAgentGateway`), `HttpsAgentTransport`,
  `EnvironmentAgentCredentials`, `AgentExecutionService`, `SqliteStateStore`,
  validadores/errores y utilidades del protocolo. También se prueba la política
  real `HttpsEndpointPolicy` para confirmar que sigue rechazando loopback.
- El harness registra explícitamente dos capacidades 1.0, schemas financieros
  que reutilizan los validadores existentes de Don Gastón y permisos por sujeto.
  Los parsers, autorización, ejecución, transporte y journal de Jarvis son sus
  implementaciones originales. No se copian ni reemplazan por mocks.
- Se inyectan únicamente configuración sintética, resolvedor de credenciales
  en memoria, política exacta del origen de prueba hacia `127.0.0.1`, CA temporal
  y fallos de respuesta del servidor de pruebas. No se relaja la política real.
  TLS valida cadena y hostname; no se instala la CA ni se desactiva verificación.

El único acceso al repositorio vecino es lectura de código/metadata. No se carga
su bootstrap, `.env`, configuración operativa, datos, logs ni secretos. El harness
es optativo y queda fuera del build/arranque y de la suite financiera normal.
`JARVIS_INTEROP_REPO` es configuración local confiable: importarlo ejecuta código
de ese checkout, por lo que nunca debe recibirse desde un payload remoto.

## Procedimiento reproducible

Precondiciones: checkout autorizado de Jarvis con dependencias ya instaladas,
dependencias locales de Don Gastón, Node 24 y OpenSSL local (se utilizó el de Git
para Windows). Para evidencia dentro del soporte declarado, Node ≥24.22.1 y <25.
No se instalaron dependencias nuevas ni se ejecutaron scripts de arranque Jarvis.

```powershell
cd D:/Documentos/don-gaston
$env:JARVIS_INTEROP_REPO = 'D:/Documentos/sir-jarvis'
npm.cmd run test:interop
npm.cmd run format:check
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run build
```

La ausencia del checkout/dependencias/OpenSSL provoca fallo explícito; no se
omite la prueba ni se sustituye el Gateway. Cada caso crea un directorio propio
en `.cache/jarvis-real-interop/` con `finance.sqlite`, `adapter.sqlite` y
`jarvis.sqlite`. Certificados y tokens son sintéticos; tokens/clave HMAC del
journal solo viven en memoria. No se imprimen credenciales ni se persisten
secretos reales. Se cierran listeners, conexiones y bases incluso si falla un
cierre; artefactos sintéticos ignorados por Git quedan retenidos.

El reinicio probado cierra y reconstruye Registry, transporte, Gateway, servicio,
adaptador y conexiones de las tres bases, con nuevas instancias de objetos y
puerto HTTPS, conservando identidades, intenciones y configuración de prueba.
Es reapertura de componentes en el mismo proceso; no un reinicio del SO ni
gestión operativa de claves entre procesos independientes.

## Resultados observados

**20/20 pruebas aprobadas, 0 omitidas y 0 fallos** en la ejecución final del
especialista de pruebas; log `.cache/jarvis-real-interop-tests.log`.

| Escenario | Evidencia comprobada |
|---|---|
| Registro 45.000 COP | `minor:"4500000"`, COP, categoría Gasolina ficticia, fecha civil `2026-11-17`, identificador estable |
| Envelope y schemas | Correlación completa, validadores reales del catálogo ejecutan schemas input/output de record y lookup |
| Replay y concurrencia | Tres solicitudes simultáneas con igual intención producen una sola petición HTTPS y un solo gasto; replay conserva respuesta |
| Consulta | Lookup devuelve el gasto original por `write_intent_id`, sin una segunda escritura |
| Reinicio completed | Journal conserva metadata; mismo record devuelve `RESULT_EXPIRED` con outcome `completed`; lookup nuevo recupera el resultado original |
| Respuesta perdida después del commit | Un gasto y reserva del adaptador; journal Jarvis `uncertain`; replay no retransmite, incluso tras reabrir |
| Recuperación de uncertain | Lookup encuentra el gasto; comparación completa del registro durable verifica que no cambió ni se desbloqueó |
| Alteración | Igual intención con importe, request_id o correlation_id diferente: conflicto antes/después de reiniciar |
| Deadline | Vencido no envía HTTPS ni reserva gasto; renovar solo deadline conserva intención y resultado |
| Aislamiento | Actor/instancia/sujeto ajenos y permisos falsificados se rechazan antes del transporte, incluso existiendo el gasto |
| Permisos mínimos | Registry solo lectura rechaza escritura; adaptador solo lectura la rechaza independientemente del Registry |
| Credenciales | Token ajeno rechaza record/lookup; inválido no genera reserva ni gasto |
| TLS y red | CA ajena y hostname incorrecto no llegan al adaptador; política productiva real rechaza loopback con resolvedor sintético sin DNS externo |
| Límites/validación | Extras, actor en input, dinero numérico, moneda/fecha inválida, versiones incompatibles y payload sobredimensionado rechazados |
| Respuestas inválidas | Correlación falsa, importe numérico y respuesta sobredimensionada causan `INVALID_RESPONSE/uncertain` sin duplicar el gasto confirmado |
| Error financiero | Categoría inexistente: resultado failed/VALIDATION_FAILED; journal Jarvis failed, reserva adaptador presente, ningún gasto, lookup found:false |

La ejecución inicial de 16 casos pasó 16/16; luego se añadieron cuatro escenarios
(deadline renovado, error de categoría, política real y hostname). Las ejecuciones
dirigidas y final responden a esas adiciones; no son una regresión financiera
repetida. Las 354 pruebas del incremento anterior son evidencia histórica, no se
cuentan como ejecutadas nuevamente aquí. No se modificaron contratos ejecutables
compartidos, servicios, dominio, migraciones ni fixtures previas.

Verificaciones finales realmente ejecutadas:

| Comando/comprobación | Resultado |
|---|---|
| `node --test tests/interop/jarvis-real-gateway.test.mjs` | 20/20; 2.035 segundos; log indicado arriba |
| Prettier write sobre ambos archivos nuevos y `package.json` | Salida 0 |
| `npm.cmd run format:check` | Salida 0; `.cache/jarvis-interop-format.log` |
| `npm.cmd run lint` | Salida 0; `.cache/jarvis-interop-lint.log` |
| `npm.cmd run typecheck` | Salida 0; `.cache/jarvis-interop-typecheck.log` |
| `npm.cmd run build` | Salida 0; `.cache/jarvis-interop-build.log` |
| `git diff --check` | Salida 0 |
| Enlaces locales en cuatro documentos actualizados | 43 válidos |
| Hashes SHA-256 de fuentes/manifiestos/migración Jarvis inspeccionados | 17 archivos sin cambios durante verificación; diff frente a HEAD vacío |

Formato, lint, typecheck y build se ejecutaron para Don Gastón. El harness
`.mjs` es JavaScript ejecutado y revisado por ESLint/Prettier; no está cubierto por
el typecheck TypeScript del proyecto. No se afirma typecheck/build del checkout
Jarvis ni de su aplicación operativa.

## Tres bases: significado y límites de coherencia

| Journal Jarvis | Journal adaptador | Ledger financiero | Significado |
|---|---|---|---|
| completed | reserva presente | un gasto | Resultado confirmado; tras reinicio recuperar output por lookup |
| uncertain | reserva presente | un gasto | Respuesta perdida; lookup recupera evidencia, no resuelve ni resetea uncertain |
| failed | reserva presente | sin gasto | Rechazo financiero confirmado; reserva conserva la intención recibida |
| rechazo previo al envío | sin reserva | sin gasto | Actor/envelope/permiso/plazo impidió la operación |
| uncertain por respuesta 401 no correlacionada | sin reserva | sin gasto observado | No inferir ausencia de commit solo del error que ve Jarvis |

Los tres archivos tienen responsabilidades diferentes y no comparten transacción.
El ledger sigue uniendo hecho, huella y resultado en su transacción original.
La reserva de frontera precede al efecto. `found:false` no autoriza generar otra
clave de escritura ni demuestra imposibilidad de un commit concurrente.

Se mantiene la semántica de idempotencia de cada capa, sin prometer entrega
exactamente una vez. Los reintentos explícitos conservan request/correlation/key;
una lectura de recuperación puede usar su propia intención nueva y referencia la
escritura original. Lookup devuelve el resultado original, no una proyección de
correcciones posteriores. No hay reconciliación automática ni respaldo coordinado
de los tres archivos. No se borra ni altera historia para recuperar respuestas.

## Diferencias restantes y siguiente paso

1. **Entorno:** repetir estos 20 casos en Node admitido por ambos proyectos. Esta
   observación funcional en 24.19.0 no certifica el soporte declarado de Jarvis.
2. **Respuesta de autenticación:** el adaptador responde 401 genérico sin confiar
   en correlación no autenticada. Jarvis lo clasifica `INVALID_RESPONSE/uncertain`,
   no como fallo financiero confirmado UNAUTHORIZED. Se documenta y conserva el
   comportamiento seguro; no se cambió ningún contrato para ocultarlo.
3. **Recuperación durable:** Jarvis conserva metadata, no output. `RESULT_EXPIRED`
   de una operación completed requiere lookup; uncertain sigue bloqueado después
   del lookup. Una futura UX/orquestación debe mostrar evidencia recuperada sin
   confundirla con reconciliación del Gateway ni repetir escrituras con nuevas claves.
4. **Integración operativa:** ningún cambio en Jarvis fue necesario para este
   harness. Su composición operativa deberá registrar capacidades/schemas,
   bindings autorizados, CA/credenciales y flujo de confirmación/recuperación.
   El flujo de comandos existente no queda habilitado por importar estas clases.
   Cualquier cambio futuro en Jarvis requiere alcance/aprobación propios.
5. **Pendiente fuera de este alcance:** respaldo/restauración coordinados,
   procedencia/distribución de schemas, rotación/almacenamiento de claves,
   tratamiento operativo de estados inciertos y prueba de composición completa.
   No se probaron Telegram, IA, bancos, FIN-01 productivo ni entrega de eventos.

Recomendación concreta: repetir el harness sin cambios en un runtime común
admitido y, después, proponer un flujo local explícito de confirmación y consulta
de escrituras inciertas antes de conectar canales. No ampliar módulos financieros
para resolver esa frontera. Fase 1 sigue abierta y uso real no autorizado.

## Archivos y coordinación

- Coordinador: `tests/interop/jarvis-real-harness.mjs`, script optativo en
  `package.json`, README, roadmap, aclaraciones del borrador contractual y este informe.
- `test_engineer`: propietario exclusivo de
  `tests/interop/jarvis-real-gateway.test.mjs`; implementó y ejecutó los 20 casos.
- `finance_domain`: revisión solo lectura de exactitud, intención, lookup e
  invariantes de las tres bases; sin cambios en reglas.
- `security_reviewer`: revisión solo lectura del harness local, identidad, TLS,
  permisos y recuperación; sin bloqueantes confirmados en el alcance sintético.
  No inspeccionó internals del repositorio vecino por restricciones de su rol;
  esa inspección correspondió al coordinador. La sugerencia de cerrar todos los
  recursos aunque uno falle fue incorporada.

Sin solapamiento de archivos, nuevas dependencias, migraciones, commits ni PR.
