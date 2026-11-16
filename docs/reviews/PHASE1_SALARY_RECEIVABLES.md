# Fase 1H — Salario neto y cuentas por cobrar

Fecha: 2026-11-15. Implementado y verificado localmente con datos sintéticos.
La Fase 1 completa permanece abierta. Sin commits, despliegue, infraestructura,
datos reales ni conexiones con Sir Jarvis, bancos, Telegram o proveedores de IA.

## Alcance implementado

- Salario neto COP positivo, versionado por fecha de vigencia. **Decisión del
  usuario:** vigencia al inicio de mes; cambios a mitad de mes rechazados hasta
  definir prorrateo. Cierres anteriores conservan su versión e importe.
- Apertura explícita de pendientes por mes, sin reconstrucción del historial
  laboral ni ingresos ficticios. Se diferencia el saldo reportado en apertura
  del devengado mediante cierres registrados en el sistema.
- Cierre mensual explícito e idempotente. Una obligación por ámbito/mes, con
  vencimiento al mes siguiente: día 5 por defecto, vencido desde el 6 usando fecha
  civil de consulta. Día configurable 1–31, ajustado al último día disponible.
- Abonos confirmados parciales o completos con asignación FIFO entre uno o varios
  periodos. Cada recibo es el único hecho de caja; las asignaciones no duplican
  ingresos ni crean consumo. Respuesta breve sin saldo pendiente espontáneo.
- Excedentes persistidos como revisión, sin caja ni asignación parcial. Replay
  devuelve siempre la decisión original, aunque después cambie la cartera.
- Consultas de cartera a fecha explícita, detalle de asignaciones y entrada de
  caja salarial mensual. Importes exactos con `bigint`, sin sumas monetarias SQL.

La fuente funcional sigue siendo `PRODUCT_RULES.md` §6 y la referencia original
§6, conservada intacta. El avance adelanta el núcleo salarial del roadmap por
solicitud explícita del usuario. No introduce una nueva tecnología de persistencia;
se mantiene ADR-001 y `node:sqlite` del entorno existente, sin dependencias nuevas.

## Caso principal verificado

Fixture: neto mensual $3.000.000 COP; apertura de septiembre y octubre de 2026 por
$3.000.000 cada uno, con corte `2026-11-01`; abono confirmado de $800.000 el
`2026-11-15`. Las cifras se declaran expresamente en las pruebas.

| Proyección consultada | Resultado |
|---|---:|
| Entrada de caja de noviembre | $800.000 COP, un recibo |
| Pendiente septiembre | $2.200.000 COP |
| Pendiente octubre | $3.000.000 COP |
| Total pendiente | $5.200.000 COP |
| Reintento con misma intención | Mismo ID, ninguna asignación adicional |
| Consumo de gastos / alertas | Sin incremento por salario |

El saldo se consulta con `getReceivables`; no forma parte de la respuesta de
`receivePayment`. También se verificaron abonos multiperiodo, pago exacto total,
excedentes y centavos con importes mayores que signed 64 bits.

## Persistencia, integridad y autorización

Migración **007 aditiva**: `salary_versions`, `salary_periods`, `salary_payments`,
`salary_allocations` y `salary_intents`. Las migraciones 001–006 no se modifican.
FK recíprocas y únicas por instancia/sujeto vinculan hechos e intenciones; triggers
prohíben actualización/borrado y reutilización de claves con gastos y deudas.

El servicio revalida actor y permisos por acción antes de toda consulta/mutación,
incluidos reintentos. El contexto proviene de una frontera confiable separada del
payload. No se implementa autenticación de usuarios reales. Otro actor autorizado
del mismo ámbito puede reintentar la intención, conservando el actor original.

La transacción `BEGIN IMMEDIATE` decide sobre el saldo vigente y guarda recibo,
asignaciones y resultado original conjuntamente. Las consultas usan snapshot.
Comandos y respuestas canónicos conservan la secuencia original; el verificador
reproduce decisiones y comprueba FIFO, importes, vínculos y cobertura de registros
al abrir/leer. Una revisión antigua no se reevalúa contra saldos nuevos.

La prueba de migración construye una base v6 con gastos, corrección de gasto,
presupuesto, alertas/ACK/cursor, deuda, pago y reemplazo auditable. Compara filas e
intenciones antes/después, verifica rollback de esquema, migra a v7 y registra
salario sin cambiar esos registros anteriores. Las pruebas de versiones 1–5 siguen
ejecutándose y ahora verifican su llegada a v7.

Backup/restauración usan el mecanismo existente a destinos sintéticos separados;
se conservan versiones, periodos, asignaciones, revisiones e IDs idempotentes.
Los triggers y huellas no protegen contra un atacante capaz de reemplazar de
forma coherente todo el archivo: permisos operativos siguen fuera del piloto.

## Evidencia ejecutada

Entorno local Windows/PowerShell, Node 24.19.0. Comandos terminados con salida 0:

| Verificación | Resultado |
|---|---|
| `npm.cmd run format` | Formato aplicado |
| `npm.cmd run check` → `format:check` | Aprobado |
| `npm.cmd run check` → `lint` | Aprobado, sin warnings |
| `npm.cmd run check` → `typecheck` | Aprobado |
| `npm.cmd run check` → `test` | **208/208**, sin omitidas: 170 previas + 38 nuevas |
| `npm.cmd run check` → `build` | Aprobado |

Los 38 casos nuevos son 30 de dominio/integración salarial y 8 de migración e
integridad. Cubren FIFO, vencimiento y años bisiestos, fecha de corte, vigencias,
idempotencia/cambios de payload, permisos revocados, actor inyectado, aislamiento,
importes >64 bits, cuatro puntos de rollback, respuesta perdida tras commit,
reapertura/restauración y cuatro carreras reales entre procesos: mismo pago,
payload incompatible, saldo insuficiente compartido y cierre mensual simultáneo.

También comprueban migración v6 con rollback, restricciones append-only/FK/claves,
alteraciones sintéticas de importe/FIFO/resultado, asignación ausente y hecho
huérfano, rechazo de corrupción en lectura y reapertura, bloqueo y límite monetario.
Los primeros ensayos detectaron un ajuste de typing en la prueba de payload
malicioso y una colisión de triggers durante la construcción de la fixture v6;
ambos se corrigieron antes de la ejecución completa aprobada.

Logs locales ignorados: `.cache/salary-receivables-format.log` y
`.cache/salary-receivables-check.log`. Bases ficticias conservadas en
`.cache/salary-tests/` y `.cache/salary-migration-tests/`, sin limpieza automática.
No se ejecutó CI remoto, pruebas de corte físico de energía ni una auditoría general.

## Archivos y responsables

| Responsable de escritura | Archivos |
|---|---|
| `finance_domain` | `src/domain/salary-receivables.ts`, `src/application/salary-store.ts`, `src/application/salary-service.ts` |
| `test_engineer`, después coordinador | `tests/salary-receivables.test.ts`, `tests/fixtures/salary-worker.ts` |
| Coordinador | `src/application/expense-store.ts`, `src/infrastructure/sqlite-expense-store.ts`, `src/infrastructure/sqlite-salary-receivables.ts`, `src/infrastructure/migrations/007-salary-receivables.ts`, `tests/salary-migration.test.ts` |
| Coordinador, expectativa de versión vigente únicamente | `tests/expense-corrections.test.ts`, `tests/monthly-budget-migration.test.ts`, `tests/event-delivery-migration.test.ts`, `tests/financed-debt-migration.test.ts`, `tests/debt-payment-correction-migration.test.ts` |
| Coordinador, documentación | `README.md`, `docs/PRODUCT_RULES.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, este informe |

El especialista de pruebas dejó sus archivos antes de alcanzar un límite de uso;
el coordinador tomó su propiedad, corrigió y ejecutó las pruebas. Sin escritores
simultáneos sobre las mismas rutas. `security_reviewer` trabajó en lectura y entregó
revisión focal inicial de servicio/dominio/migración; la consolidación y revisión
final del adaptador corresponden al coordinador. No se certifica un sandbox
independiente de solo lectura del revisor, no demostrable por este runtime.

## Límites y decisiones pendientes

- Un flujo salarial lógico por sujeto/instancia; varios empleadores y prorrateo
  siguen pendientes. No se define un número arbitrario de meses «recientes»;
  el onboarding carga individualmente los pendientes seleccionados.
- Para preservar FIFO auditable, un pago anterior al último confirmado queda en
  revisión; agregar un periodo anterior al último ya asignado requiere revisión
  sin consumir la clave. No hay todavía un flujo que resuelva esas revisiones,
  excedentes ni correcciones de pagos o aperturas salariales.
- Configurar una vigencia en o antes de un mes cerrado se rechaza conservadoramente;
  el cierre no cambia por una configuración posterior. Periodos abiertos y cierres
  son mutuamente exclusivos por mes y no se editan silenciosamente.
- La proyección `asOf` usa hechos conocidos actualmente y fecha financiera, no
  conocimiento histórico por `recordedAt`. Aperturas solo cuentan desde su corte;
  cierres desde el fin de mes. No se inventa caja histórica o salario no registrado.
- Límites: 4096 dígitos por importe, 32768 bytes por comando/resultado, 10000
  intenciones y 10000 asignaciones salariales por ámbito, archivo 64 MiB.
  Reconstrucción síncrona sin paginación y potencial coste cuadrático; rendimiento
  al límite no medido. Errores explícitos `STORAGE_LIMIT`, `STORAGE_BUSY`,
  `STORAGE_CORRUPT`, sin recuperación destructiva automática.
- Caja salarial es una proyección específica, no un flujo consolidado de todos
  los módulos. No hay cierre automático, notificaciones, ingresos extraordinarios,
  servicios externos, nuevas dependencias ni habilitación de datos reales.

Siguiente incremento recomendado: acordar e implementar correcciones auditables
de abonos y sus asignaciones, con validación de pagos posteriores y resolución
explícita de excedentes/fechas retroactivas. No declarar terminada toda la Fase 1.
