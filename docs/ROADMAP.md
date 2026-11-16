# Roadmap de Don Gastón (autónomo respecto a Jarvis)

**Regla de alcance:** el kit no habilita operación real. Los pasos se aprueban uno por uno. No abrir nuevas auditorías infinitas: criterios de salida definidos y hallazgos residuales documentados.

## Fase 0 — Fundación local (primera tarea de Codex)

- Bootstrap Node.js LTS + TypeScript estricto con herramientas de versiones verificadas.
- Estructura modular mínima, config validada, `.env.example`, `.gitignore`, README actualizado con comandos ejecutados, lint/typecheck/tests de ejemplo.
- Pruebas con datos sintéticos, sin proveedor de IA, Telegram, Docker remoto, AWS ni secretos.
- ADR inicial sobre persistencia y contrato pendiente con Jarvis (sin implementarlos).
- **Salida:** CI/linters y tests locales reproducibles; riesgos listados; sin conexión externa. Si hay incertidumbre, documentar como pendiente.

## Fase 1 — Dominio puro y libro de movimientos simulado

**Avance 2026-11-08:** gastos/categorías implementados en memoria y SQLite local
tras aprobación de ADR-001 para datos sintéticos. Ver [primer incremento](reviews/PHASE1_EXPENSE_INCREMENT.md)
y [persistencia SQLite](reviews/PHASE1_SQLITE_INCREMENT.md): migración, exactitud,
idempotencia durable, procesos concurrentes y respaldo/restauración aislados verificados.
La Fase 1 completa permanece abierta; otras proyecciones y controles de operación
real siguen pendientes. La prueba de backup sintético no
completa Fase 3 ni habilita el piloto.

**Avance 2026-11-14:** correcciones de gastos por anulación/reemplazo implementadas
en SQLite, con migración v1→v2, auditoría permanente y totales vigentes. Se verificaron
idempotencia, conflictos concurrentes, rollback, recuperación y vínculos restaurados.
Ver [alcance, pruebas y pendientes](reviews/PHASE1_EXPENSE_CORRECTIONS.md).
No se inició Fase 2 ni integración externa; la Fase 1 no se declara terminada.

- Value objects monetarios; moneda ISO; validación de cantidades; identificadores estables; eventos de caja vs consumo.
- Categorías y transacción simple con prueba de no duplicación de reintentos.
- Diseño del ledger y migraciones para DB aislada *solo después de ADR*.
- **Salida:** tests exactitud, redondeo, idempotencia, no doble conteo, autorización de sujeto; sin datos reales ni Jarvis conectado.

### Fase 1D — Presupuestos mensuales (alcance aprobado 2026-11-14)

El usuario adelantó explícitamente el núcleo de presupuestos de Fase 2 a este
incremento. Implementados límites por categoría/mes, consumo vigente, porcentaje
exacto y eventos internos 80/100 idempotentes, con migración SQLite v3. Verificados
**91/91 tests** incluyendo los 64 previos, rollback, concurrencia, reinicios,
restauración y conservación del historial v2. [Informe](reviews/PHASE1_MONTHLY_BUDGETS.md).

No hay traslado de saldo, copia automática de límites ni mensajes. La revisión
mensual conversacional requiere definir su orquestación antes de implementarse.
El resto de los casos financieros de Fase 2 sigue pendiente. Fase 1 permanece abierta.

### Fase 1E — Consulta y reconocimiento de eventos (2026-11-14)

Implementados contrato local v1, feed de alertas pendientes con paginación estable
y cursor opaco, reconocimientos durables idempotentes y migración SQLite v4 aditiva.
Verificados **115/115 tests** (91 anteriores + 24 nuevos), incluidos aislamiento,
concurrencia, reintentos, fallos pre/postcommit, reinicio, migración y restauración.
Ver [informe](reviews/PHASE1_EVENT_DELIVERY.md) y [contrato](EVENT_DELIVERY_CONTRACT_V1.md).

La entrega puede ser al menos una vez; se exige deduplicación del consumidor. No hay
reservas, worker permanente, API ni canal. Pendientes: cotejo con Jarvis, identidad
y autorización operativas, procesamiento/deduplicación externos y orquestación.
La Fase 1 completa permanece abierta.

### Incremento adelantado: Fase 1F — Deudas financiadas (2026-11-15)

Por autorización explícita del usuario se implementa el primer incremento de deuda
financiada dentro de Fase 1: apertura histórica, pagos confirmados completos/parciales
por cuota y saldo estimado. Sin amortización avanzada ni gastos de consumo duplicados.
Migración SQLite v5 aditiva, historia e idempotencia durables. **145/145 tests**:
115 previos + 30 nuevos, con concurrencia, rollback, reinicio, restauración e integridad.
Ver [informe](reviews/PHASE1_FINANCED_DEBTS.md).

Pendientes tras este incremento: correcciones auditables de pagos (incorporadas
posteriormente en Fase 1G), resolución de revisiones/conciliación, amortización
informada y calendario detallado. La Fase 1 completa sigue abierta.
Este incremento no autoriza el resto de casos de Fase 2 ni datos reales.

### Fase 1G — Correcciones auditables de pagos (2026-11-15)

Implementadas anulación/reemplazo de pagos confirmados, motivo/actor/instante,
historial enlazado, proyecciones vigentes y revisión durable de reemplazos que
exceden capacidad al considerar pagos posteriores. SQLite v6 preserva historia e
intenciones; no modela devoluciones bancarias. **170/170 tests**: 145 previos + 25
nuevos, con concurrencia, rollback, restauración y migración desde v5.
[Informe](reviews/PHASE1_DEBT_PAYMENT_CORRECTIONS.md).

Pendientes: resolución asistida de revisiones, conciliación explícita y amortización
informada. No se habilita operación real ni se declara completa la Fase 1.

### Fase 1H — Ingresos salariales y pendientes (2026-11-15)

Por autorización explícita se adelanta el núcleo salarial: salario neto versionado
con vigencias al inicio de mes, apertura por periodos, cierre mensual explícito,
abonos FIFO y consultas de devengado/recibido/pendiente/vencido. SQLite v7 aditiva,
una entrada de caja por abono confirmado y respuesta breve sin saldo espontáneo.
**208/208 pruebas**: 170 anteriores + 38 nuevas; formato, lint, typecheck y build
aprobados. Migración v6, rollback, reinicio, restauración, integridad y concurrencia
entre procesos verificados. [Informe](reviews/PHASE1_SALARY_RECEIVABLES.md).

Pendientes: correcciones auditables de recibos y asignaciones salariales, resolución
de excedentes/registro retroactivo, prorrateo y múltiples empleadores. No hay
cierre automático, recordatorios ni integración externa. La Fase 1 sigue abierta.

## Fase 2 — Casos financieros MVP

- Orquestación pendiente de revisión mensual de presupuestos; gastos fijos, deudas,
  pagos confirmados, ampliaciones salariales (núcleo FIFO adelantado a 1H), préstamos
  y suscripciones en incrementos separados.
- **Salida:** pruebas de concurrencia, transacción, reversos, auditoría, permisos, informes de caja/consumo.

## Fase 3 — Comprobantes, respaldo y privacidad

- Almacenamiento privado, referencias, índices, revisión semestral, copias y restauración verificable con fixtures.
- **Salida:** RPO/RTO medidos bajo prueba controlada, revocación y acceso denegado entre sujetos; nunca borrar sin confirmación.

## Fase 4 — Contrato con Jarvis (diseño → pruebas → aprobación)

- Comparar `AGENT_PROTOCOL_DRAFT.md` con protocolo vigente Jarvis. Resolver diferencias, versionar OpenAPI/esquemas.
- Pruebas de contrato, auth, binding de `subject_ref`, tiempo de espera, reintentos, consulta por intención y revocación.
- **Salida:** aprobación de seguridad e integración por ambos repos; solo pruebas con dobles/stubs, sin Lightsail.

## Fase 5 — Piloto privado con consentimiento separado

- Requiere respaldo + recuperación demostrados, imagen/procedencia, límites y permisos, evidencia de controles críticos, responsable de incidentes y aprobación explícita.
- No incluir datos financieros reales hasta superar la puerta de despliegue.

## Controles que NO bloquean Fase 0 documental/local

- Auditoría final de Jarvis, hosting, proveedor IA y validación dinámica del egreso: son puertas de operaciones reales, no impedimentos para generar scaffold local sintético.
