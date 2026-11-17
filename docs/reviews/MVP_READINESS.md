# Preparación del MVP — Don Gastón

**Actualización 2026-11-17:** aprobada e implementada la demostración local del
perfil mínimo. [Informe posterior](JARVIS_SYNTHETIC_INTEGRATION.md): 354/354 pruebas,
incluyendo 321 anteriores. Esta evaluación se conserva como antecedente;
no habilita uso real y sigue pendiente probar el runtime Jarvis real.

Fecha: 2026-11-16. Evaluación focal del núcleo existente y del primer flujo
integrado sintético. No es una auditoría integral ni autorización de uso real.
Base inspeccionada: commit `04734ea0d338bfb845116ae69e73337e08a2fcb9`, SQLite v10.

## Dictamen

El núcleo financiero ya permite demostrar un registro de gasto, su recuperación,
reintento idempotente y consulta mensual sin añadir otro módulo financiero.
El siguiente incremento debe concentrarse en la frontera con el consumidor:
contrato, identidad, autorización, serialización y recuperación de incertidumbre.

**No se ha demostrado todavía una operación financiera entre Jarvis y Don Gastón.**
Los servicios locales y sus pruebas no constituyen una interfaz de agentes remotos.
La compatibilidad se evalúa por separado en
[JARVIS_INTEGRATION_READINESS.md](JARVIS_INTEGRATION_READINESS.md).
Las diferencias de contrato requieren aprobación antes de cambiarlo; este informe
no define una interfaz ya compatible ni habilita FIN-01 en producción.

## Implementado y evidencia existente

La ejecución del incremento 1K dejó **321/321 pruebas aprobadas**, formato, lint,
typecheck y build aprobados. Se consultaron el informe versionado
[PHASE1_SHARED_SUBSCRIPTIONS.md](PHASE1_SHARED_SUBSCRIPTIONS.md), sección
«Evidencia ejecutada», y el log local ignorado `.cache/subscriptions-check.log`,
cuyo cierre muestra 321 pruebas, 0 fallos y la ejecución de build.
**No se reejecutaron esas pruebas en esta evaluación.** La evidencia es la del
incremento anterior; la revisión actual inspeccionó contratos, código y documentos.

| Área | Implementado localmente | Límite relevante |
|---|---|---|
| Dinero y gastos | COP exacto con `bigint`, categorías, gasto con fecha civil, totales por mes/categoría, idempotencia | Sin interpretación de lenguaje natural ni multimoneda |
| Correcciones de gastos | Anulación/reemplazo auditable y consumo vigente | No confundir corrección con devolución bancaria |
| Persistencia | SQLite v10 aislado, migraciones, transacciones, unicidad, verificación y respaldo/restauración sintéticos | Sin aprobación para datos reales ni operación desplegada |
| Presupuestos | Límites por categoría/mes, fracción exacta de consumo y eventos internos 80/100 | Sin arrastre ni revisión mensual automática |
| Entrega de eventos | Consulta paginada, cursor opaco y ACK durable | Contrato local; sin consumidor Jarvis, mensajería ni deduplicación externa demostrada |
| Deudas financiadas | Apertura resumida, pagos confirmados y correcciones auditables; cuotas nominales | Saldo estimado; no amortización exacta ni conciliación bancaria |
| Salarios | Vigencias mensuales, cierres explícitos, apertura de pendientes y pagos FIFO | Devengado no es efectivo; sin scheduler, prorrateo o correcciones salariales |
| Facturas | Pendientes por mes, importes desconocidos/estimados/confirmados, ajustes y pago completo | Caja/consumo al pagar; sin correcciones conjuntas ni pagos parciales del total |
| Préstamos personales | Contrapartes, desembolsos/abonos y posiciones por dirección | Capital no es ingreso/consumo; sin compensación ni correcciones de capital |
| Suscripciones | Snapshots de participantes, pago total, consumo propio y reembolsos FIFO | Solo reparto exacto; revisiones sin efecto financiero; sin correcciones conjuntas |

Implementaciones inspeccionadas: servicios de `src/application/`, `Money`,
el puerto de gastos, el runner SQLite y el bootstrap. Los informes por incremento
detallan las pruebas previas; esta evaluación no vuelve a auditar cada módulo.
El adaptador en memoria sigue siendo una simulación local sin durabilidad.
Las políticas de acceso inyectadas en fixtures son simuladas; no autentican usuarios
ni procesos reales. `src/app/main.ts` solo valida configuración y termina.

## Semántica que debe conservar el adaptador

1. `ExpenseService.recordExpense` recibe `amount` decimal como cadena, `currency`,
   `categoryId` existente y `occurredOn` explícito. Para 45.000 COP se envía
   `"45000"`; `Money.toJSON()` devuelve `{"minor":"4500000","currency":"COP"}`.
   El adaptador debe distinguir unidades de centavos y nunca convertir dinero a
   `number`. No pasar `"45.000"` como si fuese formato local de miles.
2. `AccessContext` se vincula fuera del input financiero. El servicio copia y
   congela instancia/sujeto/actor y exige permiso antes de toda operación o replay.
   Una cadena opaca que llega por JSON no es por sí misma una identidad confiable.
3. La clave del dominio es única por **instancia, sujeto y clave de intención**,
   compartida entre mutaciones financieras. El tipo de operación está en la huella, no en
   un namespace que permita reutilizar la clave con otro efecto. El borrador aún
   plantea una clave con capacidad: esa ambigüedad debe cerrarse al adaptar.
4. El consumidor conserva la clave tras timeout. `findIntent` permite recuperar
   el resultado original; repetir no genera una operación nueva. Una respuesta
   incierta no se traduce a éxito ni a permiso de usar otra clave.
5. `findIntent` del servicio de gastos también puede devolver categoría/corrección.
   Una capacidad de recuperación limitada al gasto debe validar el tipo antes de
   exponerlo; ausencia no autoriza reutilizar una clave de otro dominio.
6. `monthlyTotals` representa **consumo vigente**, no caja global ni obligaciones.
   Un gasto de consumo no es una cuota de deuda, un desembolso de préstamo o un
   salario devengado. En suscripciones solo la participación propia es consumo.
7. Registrar un gasto puede generar alertas internas de presupuesto en la misma
   transacción. La demo no debe enviar esos eventos ni marcarlos procesados por
   devolver la respuesta al gasto. Consultar un evento tampoco equivale a ACK.

Referencias de implementación: [ExpenseService](../../src/application/expense-service.ts)
(autorización, línea 49; registro, 82; recuperación, 110; totales, 120),
[AccessContext/ExpenseStore](../../src/application/expense-store.ts) (líneas 19–99),
[Money](../../src/domain/money.ts) (entrada, 20; salida JSON, 40),
[SQLite](../../src/infrastructure/sqlite-expense-store.ts) (transacción del hecho,
730; conflicto, 740; consulta de intención, 821),
[contrato de eventos](../EVENT_DELIVERY_CONTRACT_V1.md).

## Qué bloquea la demostración local

| Requisito | Situación y condición de cierre |
|---|---|
| Adaptación contractual aprobada | El coordinador cotejó tipos, validadores y Gateway reales de Jarvis; faltan aprobar las diferencias documentadas y fijar capacidades/esquemas de prueba |
| Identidad confiable | Definir cómo una credencial exclusivamente sintética liga instancia, sujeto y actor; validar ese vínculo antes del servicio, sin confiar en campos editables |
| Autorización por operación | Registro local explícito y permisos mínimos del consumidor; lectura no concede escritura y un sujeto no accede a otro |
| Adaptador de frontera | Validar envelope y schema, límites, fechas, correlación, errores y serialización exacta. Reutilizar los servicios; no duplicar reglas financieras |
| Recuperación | Definir lectura de resultado por intención y tratamiento de timeout/respuesta perdida con la misma clave, sin prometer exactamente una vez |
| Prueba reproducible | Consumidor simulado autorizado, SQLite temporal separada y categoría sintética presembrada; demostrar registro, consulta, replay y denegación cruzada en la frontera real acordada |

No bloquean esa demo las ampliaciones de deuda, salario, facturas o suscripciones,
la IA, Telegram, comprobantes, despliegue ni un informe global de caja. Tampoco hace
falta habilitar notificaciones o tareas permanentes. El consumidor de prueba puede
registrarse explícitamente; descubrimiento automático no es criterio de aceptación.

## Qué bloquea información financiera real

Estos requisitos son una puerta distinta; no deben convertirse en más módulos
financieros previos a la prueba sintética:

- **Autorización de alcance:** ADR-001 y la configuración permiten solo datos
  sintéticos. `DATA_MODE=synthetic` y `JARVIS_INTEGRATION_ENABLED=false` no son una
  habilitación operativa. Se necesita decisión explícita para otro modo y entorno.
- **Frontera operativa:** autenticación de procesos y sujetos, distribución/revocación
  de permisos, gestión/rotación de credenciales, TLS y restricciones de red probadas
  en el entorno autorizado. Una política `allows: () => true` de fixture no sirve.
- **Custodia y recuperación:** permisos efectivos de archivos y copias, protección
  de material privado, retención, RPO/RTO y restauración operacional comprobados.
  Un backup sintético correcto no demuestra la operación con datos reales.
- **Procedencia y operación:** revisión del cambio de integración, build identificable,
  actualización/rollback, errores y logs sin datos sensibles, responsables de
  incidentes y aprobación del piloto. No se ha validado capacidad al límite ni
  rendimiento del ledger completo para una carga real.
- **Alcance funcional del piloto:** si se permiten módulos sin correcciones conjuntas,
  debe existir una restricción explícita y un procedimiento para errores/revisiones;
  no sobrescribir registros ni resolver excedentes automáticamente. Para un piloto
  limitado a gastos no es obligatorio terminar todas esas ampliaciones.
- **Eventos, si se habilitan:** consentimiento, binding del destinatario y deduplicación
  durable en el consumidor antes del ACK. La primera demo puede excluirlos por completo.

Fuentes: [ADR-001](../adr/001-persistence.md),
[SECURITY](../SECURITY.md), [ROADMAP, fases 3–5](../ROADMAP.md) y
[ARCHITECTURE](../ARCHITECTURE.md). No se realizaron comprobaciones de infraestructura
ni se presume que esos controles operativos existan por estar documentados.

## Funcionalidad postergable

Amortización avanzada, conciliación con extractos, correcciones de salarios,
préstamos/facturas/suscripciones, cambios de precio y cancelación, resolución
conversacional de revisiones, comprobantes, multimoneda, ingresos extraordinarios,
edición/fusión de categorías/contrapartes, reportes globales, IA y automatización
mensual. Se conservan como requisitos futuros, no se eliminan ni declaran cumplidos.
Los recordatorios no autorizados y los pagos bancarios reales permanecen excluidos.

## Siguiente incremento propuesto, pendiente de aprobación del contrato

Un adaptador local de gastos sobre SQLite sintética y un consumidor simulado,
sin cambiar los módulos financieros ni Jarvis. Categoría «Gasolina» presembrada
con ID estable de fixture. Propuesta de dos capacidades, **nombres y esquemas
todavía no aprobados ni declarados compatibles**:

| Capacidad propuesta | Efecto | Servicio que reutilizaría |
|---|---|---|
| `finance.expense.record` v1.0 | Escritura | `recordExpense`, clave estable externa, importe/categoría/fecha explícitos |
| `finance.expense.lookup` v1.0 | Lectura | `findIntent`, filtrado a gasto, permite recuperar importe/categoría originales |

La consulta por intención satisface la recuperación del movimiento solicitado;
no hace falta diseñar un listado general ni exponer todos los dominios. El contrato
propuesto concreta salida y ausencia en el informe de integración. El test puede
comprobar totales directamente en el núcleo; exponer una tercera capacidad no es
necesario para esta demo. Se propone traducir determinísticamente el ámbito de la
clave wire a una clave interna, sin cambiar el namespace ni intenciones históricas.

Criterio de salida: registro de 45.000 COP con categoría correcta, misma identidad
y un único efecto tras retry/reapertura, recuperación después de respuesta perdida,
conflicto si cambia payload y rechazo de sujeto/permiso no autorizado antes de
lectura o escritura. Probar además validación/límites en la frontera acordada.
La prueba certificará exclusivamente ese flujo sintético; no autoriza FIN-01,
datos reales, despliegue ni cierre de toda la Fase 1.

## Trabajo de esta evaluación

`finance_domain` redactó este informe y el coordinador consolidó el perfil mínimo
de dos capacidades después de terminar su tarea. Se inspeccionaron documentos,
servicios y evidencia histórica; no se cambiaron reglas, código, migraciones,
dependencias o el repositorio Jarvis, y no se ejecutaron pruebas históricas.
El coordinador consolida compatibilidad, seguridad y criterios de pruebas en el
informe de integración. La semántica financiera no requiere ampliarse para avanzar.
