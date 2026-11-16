# Arquitectura de Don Gastón — decisión inicial

**Estado:** propuesta para revisión. El proyecto es **separado** de Sir Jarvis en código, datos, despliegue y credenciales. La separación física de repositorios NO sustituye autenticación/aislamiento de red.

## Responsabilidades

| Componente | Responsable |
|---|---|
| Telegram, audio, chat, autenticación del remitente, conversación, confirmación | Sir Jarvis |
| Clasificación, cálculos exactos, presupuestos, deudas, obligaciones, salarios, préstamos, recibos, reportes financieros | Don Gastón |
| Registro y permisos de agentes, routing, versionado y trazas entre servicios | Sir Jarvis, con validación independiente en Don Gastón |
| Libro financiero, idempotencia, almacenamiento y migraciones | Don Gastón |
| Docker, firewall, políticas de egreso y host | Operador/infraestructura Jarvis; nunca Don Gastón |

## Modelo de componentes

```text
[Telegram/web/voz] -- canal/actor --> [Sir Jarvis]
                                          |
                          binding sujeto + autorización + intención
                                          |  HTTPS/JSON v1 (borrador)
                                          v
                               [Don Gastón, API privada]
                              /       |         |       \
                          dominio   ledger    recibos   auditoría
                              \       |         |       /
                        [Almacenamiento propio y backups propios]
```

**MVP:** 1 instancia por propietario, sin soporte multiusuario compartido. Cualquier instancia que atienda múltiples sujetos exige análisis de amenazas, índices por sujeto, pruebas de aislamiento, modelo de llaves por sujeto, y aprobación antes de publicarse.

## Capas propuestas (crear en Fase 0 solo lo mínimo)

```text
src/
  app/              # bootstrap, composición, config segura
  domain/           # value objects, invariantes, casos financieros
  application/      # casos de uso y puertos (sin Telegram)
  infrastructure/   # persistencia, transacciones, backups, receipts
  interfaces/       # adaptador de protocolo con Jarvis; todavía NO activo
  shared/           # tipos, errores, auth context
migrations/         # esquema versionado cuando se apruebe almacenamiento
tests/              # fixtures sintéticas, unit, integration, contract
```

No crear carpetas vacías solo por coincidir con el esquema. No crear múltiples servicios internos.

## Flujos de negocio

**Lectura:** Jarvis verifica actor y capacidad de lectura; Don Gastón valida sujeto/instancia; consulta su proyección financiera y responde sin divulgar claves ni datos de otros sujetos.

**Mutación futura:** intención estable creada por Jarvis, solicitud con identificador y huella; Don Gastón valida permiso, precondiciones y monto, registra evento y resultado en **una transacción**, guarda respuesta idempotente. Si Jarvis no recibe respuesta, consulta el estado por el mismo identificador; nunca repite con nueva clave por incertidumbre.

**Confirmación:** operaciones ambiguas o delicadas deben volver al canal original; la confirmación liga actor, sujeto, operación, monto, moneda y vencimiento. No confiar en `confirmed=true` escrito libremente.

## Persistencia local aprobada (ADR-001)

SQLite local aislado está aprobado exclusivamente para datos sintéticos en
[ADR-001](adr/001-persistence.md). El adaptador usa `node:sqlite`, importes como texto
canónico y aritmética `bigint`. **No reutilizar la base SQLite de Jarvis**. Esto no
autoriza despliegue, información real ni un servicio multiusuario.

Fase 1D incorpora un puerto `MonthlyBudgetStore` y servicio determinista, separados
de canales. SQLite implementa revisiones de presupuesto y eventos internos; el
adaptador en memoria conserva su flujo de gastos previo. Consumo se proyecta desde
gastos vigentes, sin duplicar hechos ni materializar saldos que puedan desincronizarse.
Cada mutación evalúa los presupuestos afectados antes del mismo commit que confirma
su intención. Las lecturas de presupuesto, consumo y alertas comparten snapshot.

Las migraciones conservan hechos, intenciones y correcciones anteriores. Fase 1E
añade `EventDeliveryService` y `EventDeliveryStore`; `SqliteExpenseStore` delega las
operaciones a un componente interno sobre la misma conexión. No se crea otro
servicio ni se duplica el contenido financiero del evento.

La migración v4 añade índice secuencial durable, metadatos locales de cursor y
reconocimientos append-only. Un trigger indexa nuevas alertas dentro de su transacción
original. Las consultas usan snapshot y paginación por clave con límite superior;
los reconocimientos usan `BEGIN IMMEDIATE` y unicidad por instancia/sujeto/evento.
No hay reservas: varios lectores pueden recibir el mismo evento. La deduplicación
de efectos en el consumidor es necesaria para una entrega al menos una vez.

El cursor se cifra/autentica con AES-GCM, clave de 32 bytes generada por `node:crypto`
y persistida localmente. Vincula ámbito, posiciones e IDs de anclaje; no sustituye
autorización. Base y copias deben recibir la misma protección operativa, pendiente
para datos reales. No hay rotación de claves ni expiración del cursor implementadas.

El [contrato local v1](EVENT_DELIVERY_CONTRACT_V1.md) minimiza el payload y distingue
reconocimiento de procesamiento de entrega de notificaciones. No hay despachador,
API, scheduler ni integración con Jarvis. Su compatibilidad y deduplicación de
efectos externos siguen pendientes de una decisión y pruebas de integración.

## Deudas financiadas en modo simplificado

Fase 1F incorpora dominio/puerto/servicio de deudas financiadas simplificadas y un
componente `SqliteFinancedDebts` sobre la misma conexión. La migración aditiva v5
separa aperturas históricas, resultados de pago e intenciones; no crea gastos
ordinarios al registrar deuda o cuota. Un pago confirmado es un solo hecho con
proyecciones de caja y saldo estimado. Las cuotas históricas solo son resumen.

Las intenciones de deuda conservan huella y respuesta original, con FK recíprocas
y claves únicas por ámbito. Triggers en ambos namespaces prohíben reutilizar una
clave de categorías/gastos/presupuestos para deudas o viceversa. Saldo, remanente
de cuota, decisión y escritura se resuelven bajo `BEGIN IMMEDIATE`; las lecturas
usan snapshot. Al abrir se reconstruyen decisiones en orden de registro para
comprobar saldos y revisiones, sin ordenar por fechas civiles retroactivas.

El módulo no produce notificaciones ni cambia la semántica del feed de alertas.
Tasa/condiciones son información registrada; conciliación con extractos y amortización
avanzada siguen pendientes. Ver [Fase 1F](reviews/PHASE1_FINANCED_DEBTS.md).

Fase 1G añade `DebtPaymentCorrectionsService` y su puerto. La migración v6 conserva
pagos y resultados previos, amplía la relación de intenciones con correcciones y
añade una secuencia de acciones para reconstruir decisiones en orden de registro.
Una corrección puede producir un reemplazo confirmado o un resultado de revisión
sin efecto financiero. Su evento, reemplazo opcional e intención comparten commit.

La vista vigente excluye pagos retirados por correcciones aplicadas. La verificación
histórica reproduce pagos y correcciones en su orden durable, conservando las
decisiones que eran válidas entonces; no reinterpreta una revisión antigua con el
saldo actual. Las fechas civiles determinan caja por mes, no ese orden de auditoría.
Ver [Fase 1G](reviews/PHASE1_DEBT_PAYMENT_CORRECTIONS.md).

## Salario y cartera del empleador — Fase 1H

`SalaryService` autoriza por acción y ámbito, valida entradas y genera huellas;
`SalaryStore` define el puerto. El dominio puro decide vigencias, cierre, apertura,
FIFO y proyecciones con `bigint`. `SqliteSalaryReceivables` opera sobre la misma
conexión aislada de `SqliteExpenseStore`, sin rediseñar los módulos previos.

La migración aditiva v7 conserva v1–v6 y añade `salary_versions`, `salary_periods`,
`salary_payments`, `salary_allocations` y `salary_intents`. Las intenciones guardan
comando canónico, respuesta original y secuencia durable; las FK recíprocas unen
cada hecho a su intención y todas las referencias incluyen instancia/sujeto.
Triggers impiden edición/borrado y colisiones de claves con gastos y deudas.

`BEGIN IMMEDIATE` abarca lectura de saldos, decisión, hecho, asignaciones e intención.
Una revisión se persiste sin efecto de caja. Consultas usan snapshot; apertura y
lecturas reconstruyen las decisiones en secuencia de registro y comparan importes,
FIFO, vínculos y resultado almacenado. El cierre conserva su versión original y
no se vuelve a calcular con una configuración posterior. Copias restauradas usan
el mismo verificador. La huella detecta inconsistencia; no es una firma contra un
atacante con acceso de escritura completo al archivo.

Los importes positivos se almacenan como texto canónico, sin sumas SQL. Moneda COP
explícita en comandos/resultados. Límites: 4096 dígitos por importe en unidades
menores, 32768 bytes por comando/resultado, 10000 intenciones y 10000 asignaciones
salariales por ámbito; archivo 64 MiB y espera de bloqueo 0–5000 ms. Agregados exactos
pueden exceder el tamaño de un importe individual. La reconstrucción completa es
síncrona y puede tener coste cuadrático; no se midió rendimiento al límite y no
se ofrece paginación salarial. Se prioriza el pequeño ledger personal sintético.

La caja salarial es proyección de recibos confirmados; devengos y aperturas son
obligaciones, no efectivo disponible. La fecha financiera es civil y explícita;
el reloj solo registra auditoría. Sin nuevos eventos, notificaciones ni transporte.
[Alcance, pruebas y límites](reviews/PHASE1_SALARY_RECEIVABLES.md).

## Facturas recurrentes — Fase 1I

`RecurringBillService` valida entradas, contexto y permisos. El puerto
`RecurringBillStore` expone comandos y consultas; el dominio puro decide
estimaciones, revisiones y pago completo. `SqliteRecurringBills` comparte la
conexión del adaptador local sin cambiar la semántica de deudas ni salarios.

SQLite v8 es aditiva: `bill_concepts`, `bill_obligations`, `bill_adjustments`,
`bill_payments` y `bill_intents`. Las últimas conservan comando, huella, resultado
original y secuencia. Las referencias incluyen instancia/sujeto; restricciones
únicas protegen concepto/mes, pago por obligación y cadena de revisión. FK
recíprocas vinculan cada registro con su intención; triggers mantienen append-only
y evitan colisiones de claves con gastos, deudas y salarios.

Un pago tiene el mismo ID que su único `Expense` en `facts`. `bill_payments` guarda
metadatos/vínculos, no otro importe monetario independiente. El gasto conserva el
formato anterior y un registro técnico en `intents` con clave interna aleatoria,
enlazada desde el pago. Esa clave no sustituye la intención externa estable;
permite reutilizar las FK de alertas y los verificadores existentes sin reescribir
tablas antiguas. Todas las escrituras, incluidas alertas, ocurren en un único
`BEGIN IMMEDIATE`; la clave interna solo se crea para una operación nueva y no
se regenera tras un commit incierto.

Consumo y presupuesto leen el único gasto por fecha de pago. La vista de caja de
facturas referencia el mismo ID. No se suman entre sí. Un ajuste de factura pendiente
no crea gasto. Corregir aisladamente un gasto vinculado se bloquea en aplicación y
SQL hasta implementar correcciones conjuntas de factura/pago.

Las lecturas usan snapshot y reconstruyen los comandos en orden durable; verifican
estimación fuente, revisión, pago y correspondencia exacta con gasto/huella/resultado.
El control de revisión y la exclusión de pagos se validan bajo el bloqueo de escritura.
Límites locales existentes: 4096 dígitos monetarios, 32768 bytes por comando/resultado,
10000 intenciones de facturas por ámbito y 64 MiB por archivo. Reconstrucción síncrona
completa, potencial coste cuadrático y sin paginación; no se midió rendimiento al límite.
Las huellas no autentican un archivo reescrito coherentemente por un atacante.

La futura generación mensual requiere orquestación explícita, calendario y claves
estables fuera del dominio. No hay scheduler, servicio nuevo ni integración Jarvis.
[Decisiones, orquestación pendiente y evidencia](reviews/PHASE1_RECURRING_BILLS.md).

## Integración con Jarvis: propuesta, no hecho

- HTTPS + JSON versionado, autenticado; red privada o endpoint explícitamente autorizado.
- Reutilizar las convenciones **realmente vigentes** de la especificación de agentes de Jarvis, después de cotejar su versión y semántica.
- No asumir rutas ni tokens existentes. No modificar Jarvis automáticamente.
- Idempotencia de negocio, `subject_ref` vinculado, contratos con esquema, timeout y errores tipados.
- No compartir socket Docker, token Telegram, red privilegiada, ni archivos de secretos de Jarvis.

## Decisiones fuera del MVP

MCP, eventos distribuidos, cola externa, pagos reales, multiusuario compartido, sincronización bancaria, app propia y proveedores de IA para datos personales.
