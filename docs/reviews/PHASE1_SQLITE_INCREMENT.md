# Fase 1 — Persistencia SQLite de categorías y gastos

Fecha: 2026-11-08. ADR-001 aprobado expresamente por el usuario para un MVP de una
instancia personal con datos exclusivamente sintéticos. Este incremento no completa
toda la Fase 1 y no habilita operación real.

## Resultado

**Implementado y verificado localmente:** registro de categorías y gastos en SQLite,
reapertura tras finalizar un proceso, recuperación del resultado original, reintentos
sin duplicación, conflicto ante payload diferente, exactitud superior a 64 bits,
rollback, contención y concurrencia entre procesos. Backup y restauración reproducibles
en archivos separados con fixtures sintéticas.

El ejemplo «Gasté $45.000 COP en gasolina» conserva el mismo ID, actor, categoría,
fecha e importe `4500000` centavos después de finalizar el proceso y abrir desde otro.
El ejemplo compilado reintentó la misma intención y mantuvo el total. La identidad
del movimiento observado fue `e59484bf-4929-40b0-b612-8f74fc724e2a` (fixture), sin
regenerarla al recuperar. La frase humana sigue representándose como entrada
estructurada; no se incorporó interpretación por IA ni canales externos.

## Driver, migración y transacciones

Se eligió `node:sqlite` / `DatabaseSync`, incorporado en Node 24.19.0. El runtime
reportó SQLite 3.53.3. Mantiene el puerto síncrono y evita instalar dependencias
adicionales. La documentación de esta versión indica estabilidad 1.2 (*release
candidate*); no se declara una API estable ni se certifica otra versión de Node.
[Fuente oficial de Node 24.19.0](https://nodejs.org/download/release/v24.19.0/docs/api/sqlite.html).

Migración `001-expenses.ts`: SQL versionado embebido en TypeScript, disponible tanto
en ejecución fuente como compilada. `user_version`, `application_id` y tabla de
checksums identifican la base y la migración. La apertura compara además el SQL real
de tablas, índices y triggers con la migración, y rechaza discrepancias. La migración
se aplica en transacción a una base vacía; no se adopta una base de otro esquema.

`facts` almacena categorías/gastos mediante discriminador; `intents` guarda clave,
huella y resultado original. Es una concreción de las tablas conceptuales del ADR,
sin alterar las entidades de dominio. Claves únicas por instancia/sujeto/intención,
referencias circulares diferidas y referencia tipada a categoría aseguran integridad.
No se confirma un hecho sin su intención ni una intención sin su hecho correspondiente.
Triggers bloquean UPDATE/DELETE del historial financiero.

Cada mutación valida y copia los datos, abre `BEGIN IMMEDIATE`, consulta intención,
compara huella y tipo, valida la categoría del ámbito y almacena hecho+huella+resultado.
Solo responde tras commit; un fallo revierte todo. Se conserva `category:v1` y
`expense:v1`. Mismo contenido canónico devuelve el resultado original; otro contenido
produce `IDEMPOTENCY_CONFLICT`. Los IDs generados durante un intento descartado no
reemplazan el resultado persistido. `findIntent` permite resolver incertidumbre.

Se usa `journal_mode=DELETE` y `synchronous=FULL`, claves foráneas activas, consultas
parametrizadas, extensiones deshabilitadas y modo defensivo. No se adoptó WAL. El
timeout de bloqueo es 1000 ms por defecto, configurable 0–5000 ms; al agotarse se
devuelve `STORAGE_BUSY`, sin cambiar la intención. El consumidor debe consultar estado
y reintentar acotadamente con la misma clave. No hay reintentos infinitos internos.

## Exactitud, corrupción y límites

Los centavos se almacenan como `TEXT` canónico positivo y COP. Se rehidratan con
`Money.fromMinor(BigInt(texto))`; no se usan `REAL`, conversiones a `number` ni sumas
SQL para dinero. Se contrastan fila, huella y JSON completo, y se devuelven objetos
inmutables. La apertura comprueba `quick_check`, claves foráneas y todos los resultados.

| Límite operativo | Tratamiento |
|---|---|
| 4096 dígitos de centavos por gasto | Exceso → `STORAGE_LIMIT`, sin persistir ni consumir clave; el dominio en memoria no cambia |
| 32768 bytes por resultado JSON | Rechazo antes de escritura y restricción SQL |
| 64 MiB del archivo principal | Comprobación previa y `max_page_count`; no limita tamaño agregado de journal/backups/temporales |
| 10000 gastos por consulta de ámbito | Rechazo explícito; no respuesta truncada. El filtrado mensual sigue en aplicación |
| Bloqueo de 0–5000 ms | `STORAGE_BUSY`, sin regenerar clave |

Totales válidos pueden superar 4096 dígitos; el test de dos importes máximos obtiene
4097 dígitos exactos. Se probaron importes individuales superiores a signed64 y
totales que lo exceden aunque cada fila quepa. Límites técnicos no son topes de
presupuesto ni nuevas reglas financieras.

Corrupción devuelve `STORAGE_CORRUPT`, esquema/versión incompatible `STORAGE_SCHEMA`;
I/O, modo solo lectura, cierre y destino existente tienen códigos separados. No se
incluyen SQL, rutas ni valores financieros en los errores del adaptador. Una base
incompatible/corrupta no se repara, reemplaza ni vacía automáticamente.

## Respaldo y restauración

`backupTo(destino)` reserva un archivo nuevo mediante apertura exclusiva, genera un
snapshot con `VACUUM INTO` y valida el resultado. `restoreBackup(origen,destino)` abre
el respaldo en solo lectura y crea una copia verificada en otro archivo. Destinos
existentes, incluso el origen, se rechazan. Archivos parciales de operaciones fallidas
se conservan para diagnóstico, nunca se declaran válidos ni se borran automáticamente.

SQLite documenta `VACUUM INTO` como snapshot consistente de una base activa; una
interrupción durante la copia puede dejar una salida incompleta. No se equipara una
copia exitosa con protección frente a todos los fallos físicos.
[SQLite: VACUUM INTO](https://www.sqlite.org/lang_vacuum.html).

Prueba final local: snapshot de categoría+gasto, otro gasto confirmado posteriormente
y restauración separada. El snapshot conserva IDs, total y replay; el gasto posterior
queda fuera, mientras el origen lo conserva. Se observaron **1 evento posterior / 2.508 ms**
entre completar el snapshot y confirmar ese evento, y **5.546 ms** para restaurar,
abrir y verificar. Es una medición sintética de pérdida y recuperación, no un RPO/RTO
garantizado ni una política de frecuencia de backups. Fixtures finales conservadas en
`.cache/sqlite-tests/store-TEAhPN`; datos del ejemplo en `.cache/sqlite-example/`.

## Verificaciones ejecutadas

| Comando / responsable | Resultado |
|---|---|
| `node --test tests/sqlite-store.test.ts` / test_engineer | 20/20 pruebas nuevas aprobadas; typecheck también aprobado |
| Prettier local sobre archivos nuevos / responsables | Formato aplicado |
| `npm.cmd run check` / coordinador | Código 0: formato, lint sin warnings, typecheck, **46/46 pruebas**, build |
| `npm.cmd run example:sqlite` / coordinador | Código 0: proceso de escritura termina; otro recupera mismo ID y total `4500000` |
| `node dist/app/sqlite-expense-example.js write` y `read` / coordinador | Ambos código 0: build ejecutable, mismas intenciones sin duplicación |
| `git diff --check` / coordinador | Código 0; avisos informativos de normalización LF/CRLF |

Las 20 pruebas SQLite cubren: cierre/reapertura, resultados inmutables, importes y
totales exactos, fallo inyectado entre hecho e intención, carreras de dos procesos
con payload equivalente/diferente, lectura en un tercer proceso, bloqueo externo y
retry, aislamiento sujeto/instancia, revocación, solo lectura/cierre, límites monetarios
y archivo excesivo, JSON/importe/archivo corruptos, append-only/unicidad/FK, migración
desconocida, checksum/esquema alterado, snapshot/restore y rechazo de sobrescritura.
El caso de fallo usa callback de fixture `afterFactInsert`, sin exposición por protocolo.

No se repitió una auditoría general ni se ejecutaron instalaciones, despliegues,
credenciales, pagos, datos reales, APIs financieras, Telegram o Jarvis. Solo se consultó
documentación pública técnica para justificar el driver y la técnica de backup.

## Archivos y coordinación

| Responsable | Propiedad exclusiva / entrega |
|---|---|
| Coordinador | `src/infrastructure/sqlite-expense-store.ts`, `sqlite-errors.ts`, `migrations/001-expenses.ts`, `src/app/sqlite-expense-example.ts` |
| Coordinador | `package.json` (script), `docs/adr/001-persistence.md`, `README.md`, `docs/ROADMAP.md`, este informe |
| test_engineer | `tests/sqlite-store.test.ts`, `tests/fixtures/sqlite-worker.ts`; cedidos al coordinador al finalizar |
| finance_domain | Revisión sin escritura de exactitud, rehidratación, unicidad y borde 4096/4097 |
| security_reviewer | Revisión estática solo lectura de aislamiento, atomicidad, rutas y backup |

Se integraron sus observaciones: validación previa al INSERT, comparación exacta del
esquema, pruebas de bordes monetarios y corrección del filtro de objetos internos
(`GLOB 'sqlite_*'` trata el guion bajo literalmente). No hubo escrituras simultáneas
sobre archivos compartidos. Dominio, aplicación y adaptador en memoria permanecen
intactos; los 26 tests previos siguen pasando. Sin cambios de dependencias o lockfile,
sin commits/PR. Los cambios preexistentes del workspace se conservaron.

## Limitaciones y siguiente incremento

- **Simulado:** contexto y política de identidad; no hay autenticación operativa.
  El adaptador se consume a través de la aplicación, no como frontera pública.
- **No verificado:** corte de energía, fallo físico, ACL Windows, cifrado/rotación,
  host de producción, CI remoto/Linux y rendimiento a escala. `FULL` y las pruebas de
  rollback/reinicio no sustituyen esas evidencias.
- Rutas seleccionadas por composición confiable. Se rechazan URI, memoria, UNC y
  enlaces en el archivo final; no se promete resistencia a TOCTOU, enlaces/junctions
  en directorios padres, unidades de red mapeadas o administrador del filesystem.
  `0600` en archivos nuevos aplica donde el SO lo soporta; no acredita ACL Windows.
- No hay borrado automático. `.cache` retiene fixtures y copias; `.gitignore` evita
  versionarlas, pero no es control de acceso ni retención de producción.
- API SQLite *release candidate*, puerto síncrono y un escritor por vez: evaluar
  evolución solo ante necesidades medidas. La lista por ámbito tiene límite técnico;
  consultas paginadas/filtradas en el puerto quedan para otro incremento.
- Las huellas detectan inconsistencias, no manipulación por un administrador que
  reescriba coherentemente hechos, respuestas, huellas y esquema.
- El revisor de seguridad operó únicamente en lectura. Su rol declara `read-only`,
  pero la aplicación efectiva del sandbox no se pudo verificar con la metadata disponible.
- **Pendiente:** correcciones auditables por compensación, otras proyecciones,
  reglas de redondeo para operaciones futuras, contrato Jarvis y operación real.

Recomendación siguiente: definir e implementar un incremento acotado de corrección
auditable de gastos mediante compensaciones, incluyendo idempotencia y efecto en
totales, con fixtures. Acordar su semántica antes de cambiar reglas. No desarrollar
todavía presupuestos, deudas, salarios ni integraciones. Fase 1 permanece abierta.
