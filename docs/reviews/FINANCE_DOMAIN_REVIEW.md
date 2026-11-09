# Revisión del dominio financiero — Fase 0

Fecha: 2026-11-08. Responsable: subagente `finance_domain`.

Alcance: revisión documental de `PRODUCT_RULES.md`, la referencia funcional histórica del 2026-11-01 y `TRACEABILITY.md`. No se modificaron esas fuentes ni se ejecutaron operaciones financieras. Este informe no certifica código ni integración con Jarvis.

## Estado y conclusión

- **Implementado:** este informe documental. El bootstrap y sus resultados deben verificarse por separado por el coordinador.
- **Simulado:** los ejemplos de este informe son exclusivamente sintéticos; no son movimientos registrados ni pruebas ejecutadas.
- **Pendiente:** dominio financiero, persistencia, autorización, idempotencia transaccional, políticas de redondeo y contrato operativo.

No se identificó una contradicción que bloquee el bootstrap local autorizado. Las reglas financieras no deben implementarse incidentalmente como parte de Fase 0. Los ejemplos pueden demostrar representación exacta y separación de vistas sin convertirse en un ledger.

## Invariantes y trazabilidad

| Invariante | Fuente | Consecuencia para implementación posterior |
|---|---|---|
| Dinero exacto con moneda ISO 4217 | Reglas §11; referencia §11; FIN-M01 | Usar unidades menores enteras o decimal seguro; no operar dinero con `number` binario. Preservar moneda, escala y tasas históricas. |
| Devengado no es recibido | Reglas §6; referencia §6; FIN-S01 | Generar salario esperado aumenta cuenta por cobrar, no caja disponible. Recibido, pendiente y vencido son magnitudes distintas. |
| Caja y consumo son proyecciones distintas | Reglas §2, §4, §7, §8; FIN-M02 | Un hecho tiene identidad estable; una compra financiada y sus pagos no se suman como consumo repetido. |
| Capital no es ingreso ganado ni consumo nuevo | Reglas §7; referencia §7 | Préstamo recibido: caja y pasivo. Préstamo otorgado: caja y cuenta por cobrar. Devolver capital reduce la obligación o el activo correspondiente. |
| Interés y capital se distinguen | Reglas §4; referencia §4; FIN-D01 | No deducir que toda cuota amortiza capital. Conservar condición estimada y conciliar con evidencia posterior. |
| Solo pagos confirmados reducen obligaciones | Reglas §4, §5, §8; FIN-C01 | Fecha prevista, cuota programada o obligación mensual no prueban pago. |
| FIFO de salario y reembolsos | Reglas §6, §8; referencia §6, §8 | Aplicar abonos a periodos más antiguos, conservar asignaciones y preguntar por excedentes salariales. No extender FIFO a otros casos por suposición. |
| Facturas por concepto y periodo | Reglas §5; referencia §5 | Meses impagos coexisten; no sobrescribir deuda anterior. Servicios admiten pago completo en primera versión; no generalizar los abonos de préstamos. |
| Presupuesto mensual y avisos limitados | Reglas §3, §13; referencia §3, §13; FIN-B01 | Sin arrastre, sin reescribir historia; 80/100 una vez por categoría/periodo. Salto directo a 100 produce solo ese aviso en el evento. |
| Idempotencia de negocio | Reglas transversales; FIN-I01–I04 | Intención estable, huella, unicidad y transacción; conflicto ante carga distinta; incertidumbre exige consulta. Un test de memoria no demuestra atomicidad durable. |
| Correcciones auditables | Reglas transversales; referencia §2, §6, §8 | Compensaciones o historia append-only; cambios de salario y participantes no alteran periodos pasados. |

## Diferencias de detalle y decisiones pendientes

Las siguientes son precisiones presentes en la referencia y resumidas u omitidas en las reglas trasladadas; no se interpretan como autorización para eliminarlas:

1. Referencia §6 limita onboarding salarial a periodos recientes impagos desglosados por mes. Reglas §6 conserva vigencia y FIFO, pero no repite ese límite. Mantenerlo en el diseño futuro; aclarar qué significa «recientes» antes de implementar onboarding.
2. Referencia §3 prevé porcentajes configurables en el futuro y copia de últimos importes **confirmados**. Reglas §3 usa «montos vigentes». No copiar borradores ni introducir umbrales configurables durante este bootstrap.
3. Referencia §8 excluye repartos personalizados y contempla al titular «cuando corresponda». Reglas §8 mantiene división igualitaria. La composición del grupo y el tratamiento del residuo indivisible necesitan una política explícita antes de implementar reparto.
4. Referencia §11 permite elegir moneda principal en onboarding y distingue cotización no disponible. Reglas §1 y §11 conservan COP por defecto y tasas históricas. El ejemplo COP no demuestra soporte general de monedas ni permite fijar permanentemente esa moneda.
5. Referencia §9 exige preservar el movimiento aunque se elimine un archivo y desambiguar coincidencias de búsqueda. Reglas §9 resume la gestión de comprobantes; esos controles siguen pendientes y no se implementan en Fase 0.
6. Referencia §12 contiene reglas detalladas de selección, privacidad y presupuesto de proveedores. Su resumen en reglas §12 no autoriza seleccionar ni conectar proveedores ahora.

No hay contradicción necesaria entre notificaciones permitidas por defecto (§13) y autorización del canal (§3): Don Gastón propone eventos y Jarvis decide entrega y preferencias. No hay notificaciones implementadas ni se presupone contrato operativo.

Decisiones de dominio que deben resolverse antes de los módulos correspondientes:

- Modo de redondeo por moneda/operación, precisión intermedia de intereses y cambio, y asignación determinista de residuos. Fase 0 puede evitar divisiones y conversiones; no debe elegir silenciosamente estas reglas.
- Qué proyección alimenta cada presupuesto y tratamiento de intereses, devoluciones y correcciones para los umbrales; caja y consumo no son intercambiables.
- Desempate FIFO para obligaciones de igual periodo y tratamiento explícito de excedentes fuera del caso salarial documentado.
- Calendario y zona horaria para cierres y vencimientos, sin inferirlos de la máquina de ejecución.
- ADR de persistencia y contrato: deben seguir pendientes sin migraciones ni vínculo Jarvis.

## Ejemplos sintéticos reproducibles como futuros casos

Todos los valores siguientes están expresados en unidades menores enteras de COP; no necesitan redondeo. Los identificadores son ficticios.

| Caso | Entradas sintéticas | Resultado esperado |
|---|---|---|
| Exactitud | `9007199254740993n + 1n` | `9007199254740994n`, sin conversión intermedia a `number`. |
| Préstamo recibido | Hecho `fixture-loan-1`, capital `120000n` | Caja `+120000n`, pasivo `+120000n`, ingreso ganado `0n`. |
| Pago de capital confirmado | Hecho `fixture-repayment-1`, capital `30000n` | Caja `-30000n`, pasivo `-30000n`, consumo nuevo `0n`; una sola salida. |
| Suscripción compartida | Total `120000n`, tres participantes incluido titular | Caja `-120000n`, consumo propio `40000n`, cuentas por cobrar `80000n`; conservar vínculo al mismo hecho. |
| Reembolso posterior | Recibido `40000n` del caso anterior | Caja `+40000n`, cuenta por cobrar `-40000n`, ingreso ganado `0n`, sin volver a registrar consumo. |
| Salario devengado | Obligación de `500000n`, sin abonos | Cuenta por cobrar `500000n`, caja recibida `0n`. |
| Salario FIFO | Periodos antiguos pendientes `200000n` y `300000n`; abono `250000n` | Aplicar `200000n` al primero y `50000n` al segundo; caja recibida total `250000n`. |
| Salto de presupuesto | Presupuesto `100000n`; consumo pasa de `70000n` a `110000n` | Proponer solo evento 100 en esa operación; ninguna entrega real. |

## Criterio de cierre de esta revisión

Informe escrito en su única ruta asignada, fuentes preservadas, invariantes trazadas y decisiones pendientes explícitas. No se ejecutaron tests desde este rol. La aceptación del bootstrap corresponde al coordinador; Fase 1 permanece pendiente.
