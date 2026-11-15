# ADR-001 — Persistencia
Estado: **aprobado por el usuario el 2026-11-08**.
Alcance: SQLite local aislado para el MVP de una instancia personal, exclusivamente
con datos sintéticos. Importes como texto canónico, cálculos `bigint`, transacción
atómica e idempotencia durable; almacenamiento independiente de Sir Jarvis.
No autoriza datos reales, despliegues, infraestructura o conexiones externas.
Responsable: coordinador, con revisión de dominio/seguridad y pruebas independientes.
La Fase 1 completa permanece abierta.

Actualización Fase 1G, 2026-11-15: `006-debt-payment-corrections.ts` añade correcciones
append-only y orden durable de acciones. Amplía `debt_intents` preservando sus columnas
anteriores y respuestas exactas. FK recíprocas, relación explícita del reemplazo y
unicidad parcial de correcciones aplicadas aseguran correspondencia y exclusión de
escrituras incompatibles. Pago original y tablas financieras previas no se reescriben.
Migración y mutaciones son transaccionales; el runner verifica v5 antes y v6 después.
Escritura migra hasta v6; puertos anteriores siguen admitiendo solo lectura según
su versión y correcciones de pagos exige v6. Sin cambio de driver, dependencias o
autorización para información real. [Evidencia](../reviews/PHASE1_DEBT_PAYMENT_CORRECTIONS.md).

Actualización Fase 1F, 2026-11-15: `005-financed-debts.ts` añade aperturas de deudas,
resultados de pagos y sus intenciones sin reconstruir tablas previas. Dinero en
texto canónico, cálculo `bigint`, FK recíprocas y unicidad por ámbito. Triggers en
ambos namespaces impiden colisiones con intenciones financieras anteriores.
La confirmación decide saldo/cuota y registra hecho, huella y respuesta en una
transacción; un resultado de revisión no genera caja. Apertura en escritura migra
hasta v5; el puerto nuevo exige v5, manteniendo consultas anteriores en versiones
previas de solo lectura. Sin cambio de driver ni dependencias. No hay downgrade.
Se mantienen las restricciones sintéticas. [Evidencia](../reviews/PHASE1_FINANCED_DEBTS.md).

Actualización Fase 1E, 2026-11-14: migración aditiva `004-event-delivery.ts`, con índice
secuencial, metadatos locales de cursor y reconocimientos append-only. No reconstruye
ni modifica tablas históricas. El trigger de alerta crea su índice en la transacción
financiera; reconocer es otra transacción única por ámbito/evento. El runner genera
una clave local de cursor con `node:crypto` y la confirma junto al esquema. Las copias
conservan esa clave y los reconocimientos; la protección/rotación operativa sigue
pendiente. Apertura con escritura migra hasta v4; el puerto de entrega exige v4,
aunque consultas financieras previas sigan admitiendo solo lectura de v1/v2/v3.
Sin cambio de driver ni dependencias. [Evidencia](../reviews/PHASE1_EVENT_DELIVERY.md).

Actualización Fase 1D, 2026-11-14: `003-monthly-budgets.ts` incorpora revisiones de
presupuestos y alertas internas append-only. Amplía el namespace de `intents` con
`budget_id`, exclusivo de hechos/correcciones, y conserva las columnas históricas
sin cambiar huellas ni resultados. Apertura con escritura migra v1/v2 a v3 en una
transacción; solo lectura admite v1/v2 sin migrar. Versiones anteriores del binario
rechazan v3; no existe downgrade. La generación de alertas comparte la transacción
del gasto, corrección o presupuesto. No se añade driver ni tecnología. Se mantienen
todas las limitaciones de uso sintético. [Evidencia](../reviews/PHASE1_MONTHLY_BUDGETS.md).

Actualización 2026-11-14: correcciones auditables aprobadas por el usuario. La migración
`002-expense-corrections.ts` añade eventos append-only y amplía `intents` para aceptar
anulación sin gasto nuevo o reemplazo atómico. La migración 001 permanece intacta.
Los registros de `facts` y las columnas históricas de `intents` se preservan exactamente;
la copia de la tabla de intenciones es una operación de esquema, no una corrección de
datos financieros. Las huellas `category:v1` y `expense:v1` no cambian.

La migración verifica v1 antes de actuar, reconstruye la tabla dentro de una transacción,
verifica esquema, datos y claves foráneas antes del commit y restablece su enforcement
al salir. En caso de fallo se revierte todo. Se sigue el procedimiento de reconstrucción
de tabla de [SQLite](https://www.sqlite.org/lang_altertable.html#making_other_kinds_of_table_schema_changes).
Abrir con escritura migra v1 a v2; abrir solo lectura permite consultar v1 sin cambiarla.
No se ofrece downgrade a v1 y el binario anterior no puede abrir una base v2.

Las claves de corrección comparten namespace de intención por instancia/sujeto. Una
restricción única impide dos correcciones del mismo gasto; FK y triggers vinculan
evento, reemplazo opcional e intención. Una intención de anulación nunca admite un
gasto oculto asociado. Consultas de totales consideran solo gastos vigentes; historial
y replay conservan los originales. [Evidencia del incremento](../reviews/PHASE1_EXPENSE_CORRECTIONS.md).

Se compararon SQLite aislado y PostgreSQL/Supabase antes de crear adaptadores o migraciones.
Criterios: unicidad transaccional de intención y huella, concurrencia, auditoría,
aislamiento, costo, respaldo y restauración demostrada con fixtures (RPO/RTO).
No reutilizar almacenamiento de Jarvis. SQLite fue elegido; ningún proveedor externo
fue contratado o conectado.

Las simulaciones previas no probaban idempotencia durable. La aprobación precedió
al incremento SQLite; su evidencia y límites están en
[PHASE1_SQLITE_INCREMENT](../reviews/PHASE1_SQLITE_INCREMENT.md).

Actualización 2026-11-08 — primer incremento de Fase 1: se incorpora un adaptador
en memoria exclusivamente sintético. No elige DB ni resuelve este ADR. Una única
entrada del mapa conserva hecho, huella y resultado, sin I/O ni esperas; esto
solo simula atomicidad dentro del mismo proceso. Reinicios pierden las claves y
los hechos. Un adaptador durable requiere decisión aprobada, unicidad y transacción
real, pruebas de concurrencia/fallos y respaldo/restauración.

## Decisión y contexto

Se adopta **SQLite en un archivo exclusivo de Don Gastón, en disco local**, para
persistir categorías y gastos con fixtures sintéticas. Se conserva el adaptador en
memoria y el puerto síncrono. La comparación siguiente documenta la decisión original.

La arquitectura vigente contempla una instancia por propietario y un monolito modular.
El volumen y la concurrencia todavía no se han medido; se asume carga reducida para
evaluar la opción, sin convertir esa suposición en una garantía. SQLite está orientado
al almacenamiento local integrado; recomendamos aprovechar ese ajuste para evitar
operar un servidor adicional en este paso. [Usos apropiados de SQLite](https://www.sqlite.org/whentouse.html).

El alcance aprobado es exclusivamente persistencia local sintética del
flujo de categorías/gastos existente. No habilita datos reales, alojamiento, acceso
remoto, proveedores, credenciales, endpoints o integración Jarvis.

## Comparación

Supabase administrado se compara como una forma de operar PostgreSQL con servicios
adicionales, no como un motor diferente. [Base de datos de Supabase](https://supabase.com/docs/guides/database/overview).

| Criterio | SQLite local aislado | PostgreSQL autogestionado | Supabase administrado |
|---|---|---|---|
| Transacción/idempotencia | Transacción local con clave única; tratar contención explícitamente | Transacción y restricciones únicas; manejar conflictos/reintentos | Mismas garantías del motor si toda la operación usa una transacción; llamadas HTTP separadas no bastan |
| Concurrencia | Un escritor a la vez; lectores concurrentes. Adecuación por medir | Control de concurrencia orientado a múltiples sesiones | PostgreSQL más límites y conexiones del servicio contratado |
| Operación propuesta | Archivo y proceso local; sin servidor adicional | Requiere administrar servicio, roles, actualizaciones y conexiones | Requiere proyecto externo, configuración, credenciales y revisión del proveedor |
| Dinero | Propuesta: centavos como texto canónico y suma `bigint` en aplicación | `NUMERIC` exacto o texto, con límites y transporte explícitos | Igual que PostgreSQL; comprobar también serialización de API/driver |
| Aislamiento | Archivo exclusivo, permisos del SO y validación de sujeto en aplicación | DB/roles exclusivos, permisos mínimos y validación de sujeto | Proyecto/esquema y roles adecuados; RLS no reemplaza validación del contexto |
| Respaldo | Snapshot consistente y restauración en archivo separado | Dump o respaldo físico/archivo WAL según objetivo | Capacidades y retención dependen del plan; restauración propia por verificar |
| Costo operativo estimado | Menor carga inicial; disco, copias y mantenimiento siguen teniendo costo | Mayor trabajo de operación para este alcance | Cuota/consumo y extras por cotizar antes de contratar |
| Ajuste actual | Recomendado bajo las condiciones de este ADR | Alternativa si aparecen requisitos de concurrencia o servicio remoto | No recomendado para el siguiente incremento local; añade decisiones externas pendientes |

La comparación de carga operativa y ajuste es una valoración del proyecto, no un
benchmark ni una cotización. No se verificaron precios ni se asumió un plan gratuito
como garantía de recuperación. Las capacidades de concurrencia y restricciones están
descritas por [SQLite](https://www.sqlite.org/lang_transaction.html),
[PostgreSQL: concurrencia](https://www.postgresql.org/docs/current/mvcc.html) y
[PostgreSQL: restricciones](https://www.postgresql.org/docs/current/ddl-constraints.html).

## Diseño aprobado e implementación

Driver: `node:sqlite` / `DatabaseSync`, incluido en Node **24.19.0**. Se verificó
localmente SQLite **3.53.3** con `select sqlite_version()`. No se añadieron dependencias,
binarios ni scripts de instalación. La API síncrona conserva el puerto y espera al
commit. La documentación de esta versión clasifica el módulo como *release candidate*
(estabilidad 1.2); se usa bajo esa limitación para el incremento sintético. Cambios de
runtime requieren repetir la suite de compatibilidad.
[Node 24.19.0: SQLite](https://nodejs.org/download/release/v24.19.0/docs/api/sqlite.html).

Se implementó migración `001-expenses.ts` con SQL versionado, `user_version`,
`application_id`, checksum e inspección del esquema real. El SQL se empaqueta con
TypeScript para que fuente y build apliquen la misma migración sin copia manual de
assets. No se modifica una versión aplicada: una evolución exige otra migración.

Las entidades se almacenan en `facts`, con discriminador `category|expense`, y en
`intents`. Esto concreta las tablas conceptuales del análisis previo sin cambiar
el dominio: cada hecho tiene una intención y cada intención referencia ese mismo
hecho mediante claves foráneas circulares diferidas y unicidad por ámbito/clave/ID.
La categoría de un gasto referencia el mismo ámbito y el tipo `category`.

Se usa rollback journal **DELETE** y `synchronous=FULL`, sin adoptar WAL en este paso.
Un único escritor por vez; `BEGIN IMMEDIATE` y espera nativa de 1000 ms por defecto,
configurable entre 0 y 5000 ms. Al agotarse, error `STORAGE_BUSY`: conservar clave,
consultar estado y reintentar de forma acotada desde el consumidor. No hay bucles
de reintento internos ni se generan claves nuevas.

Límites operativos del adaptador: 4096 dígitos por importe en centavos,
32768 bytes por resultado serializado, 64 MiB por archivo principal y 10000 gastos
por consulta de ámbito (el puerto actual lista antes de filtrar). Se rechazan excesos
con `STORAGE_LIMIT`; no se truncan datos ni se cambian reglas de `Money`. Totales con
4097 dígitos siguen admitidos. Journal, snapshots y temporales requieren espacio
adicional; 64 MiB no es una cuota total del filesystem.

Los criterios siguientes conservan la trazabilidad del diseño previo:

1. Un archivo exclusivo por instancia, ajeno a Jarvis, y una capa de persistencia
   detrás del puerto actual. No compartir el archivo por filesystem de red. Si se
   adopta WAL, sus procesos deben estar en el mismo host; elegir y probar modo de
   journal, sincronización y espera por bloqueos antes de afirmar durabilidad.
   [SQLite WAL](https://www.sqlite.org/wal.html).
2. Tablas conceptuales de categorías, gastos e intenciones. Clave única de intención
   `(instance_ref, subject_ref, intent_key)`, todos `NOT NULL`, compartida entre tipos
   de operación. Claves y relaciones de categoría/gasto incluyen el ámbito completo.
   Activar y verificar claves foráneas por conexión; ningún gasto puede referenciar
   una categoría de otro sujeto o instancia. El SQL está en la migración 001.
3. La intención conserva versión de canonicalización, huella, tipo, ID del hecho y
   resultado original serializado. Categorías y gastos conservan actor creador y fecha
   civil; el resultado recuperado no regenera IDs ni cambia el actor. Fecha civil no
   equivale a timestamp técnico de auditoría: si se añade este último, será un campo separado.
4. Lectura de intención y validación de categoría dentro de la transacción de escritura.
   SQLite: `BEGIN IMMEDIATE`, comprobar intención; si existe, comparar y
   devolver el resultado original o conflicto. Si no existe, insertar hecho e intención
   y hacer commit antes de responder. Ante fallo, rollback completo. La restricción
   única es obligatoria aunque la aplicación ya haya consultado. `SQLITE_BUSY` requiere
   espera/reintento acotado con la misma clave; un resultado incierto exige consultar
   estado antes de volver a intentar. [Transacciones SQLite](https://www.sqlite.org/lang_transaction.html).
5. Registros append-only. Sin actualización/borrado financiero en el repositorio del
   adaptador; triggers protegen las tablas y hay pruebas directas de esas restricciones.
   No afirmar que esto impide a un administrador del archivo manipularlo. Correcciones
   futuras requerirán eventos auditables y otro incremento.

## Representación monetaria y compatibilidad

El dominio actual admite `9223372036854775808n` centavos y sumas por encima de ese valor.
Esto excede el entero con signo de 64 bits; tampoco basta con que cada fila individual
quepa si el total mensual no cabe. SQLite usa enteros de hasta 64 bits y sus afinidades
numéricas pueden convertir valores a punto flotante. Por eso se propone `amount_minor`
como `TEXT` canónico, con restricciones de dígitos, sin signo/ceros iniciales e importe
positivo en gastos. No usar afinidad `NUMERIC`, `CAST`, `SUM` ni `TOTAL` para estos
importes: el adaptador devuelve texto, valida y rehidrata con `Money.fromMinor(BigInt(texto))`;
la aplicación suma con `bigint`. [Tipos de SQLite](https://www.sqlite.org/datatype3.html).

En PostgreSQL `bigint` tiene el mismo límite de 64 bits; `NUMERIC` ofrece exactitud
con límites propios. Una escala declarada puede redondear entradas, por lo que no
debe usarse para corregir silenciosamente datos inválidos. Evaluar enteros `NUMERIC`
validados y transporte textual, o texto si se busca conservar la semántica actual.
No imponer un límite monetario de negocio por conveniencia del motor.
[Tipos numéricos PostgreSQL](https://www.postgresql.org/docs/current/datatype-numeric.html).

Los límites físicos de longitud de entrada, motor y driver deben documentarse con
errores claros; texto tampoco significa capacidad ilimitada. Si se necesita limitar
el rango admitido por producto, requiere decisión explícita. Para ambos motores,
JSON usa texto para centavos y el resultado persistido debe rehidratarse y validarse;
`JSON.parse` solo no recupera el objeto `Money` ni sus invariantes.

Se preservan `category:v1` y `expense:v1` y su normalización actual. Cambiar la huella
requiere estrategia de versionado compatible con reintentos anteriores. El puerto
actual es síncrono; un driver asíncrono exigiría evolucionarlo junto con los casos de
uso y tests, esperando siempre al commit. Driver y versión de motor se verificaron
para este incremento según la sección de implementación.

## Respaldo, restauración y seguridad

Para SQLite se propone una copia consistente mediante la API de backup u otra técnica
oficial soportada por el driver elegido; copiar solo el archivo principal mientras
hay escrituras no será el procedimiento de respaldo. Restaurar siempre a un destino
sintético separado para comprobar integridad y reintentos, sin sobrescribir el origen.
[Backup SQLite](https://www.sqlite.org/backup.html).

PostgreSQL dispone de dump, respaldo de filesystem y archivo continuo/PITR; cada
estrategia necesita pruebas y objetivos propios.
[Backup y restauración PostgreSQL](https://www.postgresql.org/docs/current/backup.html).
En Supabase deben verificarse plan, retención y recuperación; el respaldo de DB no
incluye los objetos de Storage. Esa separación será relevante si se incorporan
comprobantes en otra fase. [Backups Supabase](https://supabase.com/docs/guides/platform/backups).

Para cualquier opción faltan política de frecuencia/retención, ubicación protegida,
cifrado y gestión de claves, responsable y objetivos RPO/RTO aprobados para un piloto.
La prueba sintética medirá pérdida respecto al último snapshot y tiempo de restauración;
no debe declarar una garantía de producción. No se elimina automáticamente ningún dato
ni recibo, ni se restaura un respaldo real bajo esta propuesta.

La aplicación sigue revalidando identidad y permisos. En PostgreSQL/Supabase habría
que verificar además roles y privilegios; una conexión con bypass de RLS no queda
aislada por esas políticas. [RLS Supabase](https://supabase.com/docs/guides/database/postgres/row-level-security).
No reutilizar cuentas, archivos, almacenamiento ni credenciales de Jarvis.

## Criterios de aceptación del siguiente incremento, después de aprobar el ADR

- Registrar, cerrar y reabrir: mismo ID, actor, importe y resultado por intención.
- Inyectar fallo entre hecho e intención: rollback, sin hechos huérfanos ni claves consumidas.
- Simular commit seguido de pérdida de respuesta: consulta y replay sin duplicación.
- Dos procesos/conexiones con misma clave y payload: un hecho y un resultado; payload
  distinto: un ganador y un conflicto. Probar además contención y límite de espera.
- Importes por encima de `2^53-1` y `2^63-1`, y total por encima de `2^63-1` aunque
  cada fila quepa: persistencia, serialización y suma exactas; sin conversiones a `number`.
- Claves foráneas/aislamiento y permisos por acción, incluidos lectura y reintento
  tras revocación. Categorías y gastos protegidos contra mutación histórica.
- Migración versionada sobre base sintética vacía, validación de datos al rehidratar
  y error explícito ante corrupción; no regenerar una intención corrupta.
- Snapshot/restauración sintética en destino separado: mismas intenciones, IDs,
  categorías y totales; prueba de integridad y mediciones RPO/RTO documentadas.
- Suite actual y nuevos tests locales reproducibles; sin acceso externo ni datos reales.

Estos fueron los criterios de la comparación inicial. La evidencia SQLite ejecutada
se detalla en [el informe del incremento](../reviews/PHASE1_SQLITE_INCREMENT.md);
la [revisión previa](../reviews/PHASE1_PERSISTENCE_READINESS.md) se conserva como histórico.

## Cuándo reconsiderar

Reconsiderar PostgreSQL si se requieren varios hosts escritores, acceso de servicio
remoto, contención sostenida que incumpla objetivos medidos o recuperación/operación
que el diseño SQLite no pueda satisfacer. No hay mediciones actuales que demuestren
esas necesidades. Supabase exigiría además aprobación de proveedor, región, privacidad,
presupuesto y configuración; autohospedar toda su plataforma no simplifica este incremento.

**Decisión aprobada e implementada para datos sintéticos:** SQLite local aislado,
centavos textuales canónicos, sumas `bigint`, commit único de intención/hecho/resultado
y respaldo/restauración sintéticos en destino separado mediante `VACUUM INTO`.
La Fase 1 permanece abierta y no se habilita operación con datos reales.
