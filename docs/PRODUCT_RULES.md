# Don Gastón — reglas de negocio (v0.1, trasladadas a agente independiente)

**Estado:** especificación funcional; el avance implementado se documenta en los informes de Fase 1, exclusivamente con datos sintéticos. Base: acuerdos registrados el 2026-11-01 en `REFERENCIA_FUNCIONAL_JARVIS_2026-11-01.md`, conservada íntegra. Don Gastón recibe intenciones estructuradas; su futura respuesta a Jarvis sigue sujeta al contrato pendiente. No opera Telegram ni se apropia del canal. Si hay discrepancia con la referencia, documentar y pedir autorización.

## 1. Perfil y experiencia

- Instancia autohospedada por propietario; COP por defecto; datos aislados de Jarvis.
- Jarvis recibe voz/texto/imagen y presenta confirmaciones. Don Gastón ejecuta **reglas deterministas**, no actúa directamente sobre mensajes o claves de Telegram.
- Ante ambigüedad pedir aclaración al canal origen a través del contrato, no inventar cifras.
- Lenguaje amistoso, humor leve configurable, sin moralizar ni presionar.

## 2. Categorías, gastos, ingresos

- Categorías/subcategorías iniciales predeterminadas o vacías; editables sin perder historia.
- Aprender reglas de clasificación mediante correcciones auditadas; si baja confianza, preguntar.
- No confundir ingreso ganado con dinero prestado/reembolsos. Registrar ingresos variables y gastos individuales.
- Una salida por pago de deuda; mostrar vistas distintas de consumo y flujo de caja, sin duplicación de movimientos.

### 2.1 Correcciones auditables de gastos — decisión aprobada 2026-11-14

Ampliación explícita aprobada por el usuario después del incremento SQLite. Concreta
la regla transversal append-only sin modificar la referencia histórica del 2026-11-01.

- Anular exige intención explícita, gasto existente vigente y motivo. El gasto
  original permanece consultable y deja de contribuir al consumo vigente. No es
  un reembolso, movimiento de caja ni gasto ordinario negativo.
- Corregir importe, categoría o fecha crea una anulación y un nuevo gasto, en una
  sola operación atómica. Se comunica un reemplazo completo: importe positivo,
  moneda explícita COP, categoría existente y fecha civil. Los campos no corregidos
  se repiten de forma explícita; no se infieren de un mensaje ambiguo.
- El evento conserva ID, gasto original, reemplazo opcional, motivo, actor autorizado
  y fecha/hora UTC de registro. Actor y reloj vienen de la aplicación, fuera del
  payload financiero. El motivo se normaliza con trim, tiene 1–500 caracteres y
  no admite controles internos; timestamp UTC canónico con milisegundos.
- El total mensual por categoría es una vista **vigente**: excluye originales
  anulados y cuenta solo reemplazos vigentes. Si cambia la fecha, se retira el importe
  del mes original y se incorpora al mes de la fecha nueva. Si solo cambia importe
  o categoría, el efecto sigue en el periodo financiero indicado, aunque la corrección
  se registre después. La evidencia temporal del cambio permanece en el evento.
- Cada gasto admite como máximo una corrección aplicada por instancia/sujeto. Dos
  intenciones incompatibles compiten por ese gasto: una se aplica y la otra obtiene
  conflicto. Es posible corregir el reemplazo vigente, formando una cadena auditable;
  no se reactiva el original ni se vuelve a corregir un gasto ya retirado.
- La clave de intención comparte ámbito con altas de gastos y categorías. Igual clave
  y contenido canónico devuelve la corrección original; contenido diferente genera
  conflicto. El replay conserva IDs, actor y timestamp anteriores, incluso si el
  original ya fue corregido. Reintentar el alta original tampoco lo reactiva.
- Permiso explícito `expense:correct` para anular/reemplazar y `expense:read` para
  historial y consulta por intención. Revalidación antes de replay y aislamiento por
  instancia/sujeto; un gasto ajeno responde como inexistente.
- Historial consultable en ambas direcciones: gasto reemplazado, nuevo gasto, motivo,
  actor e instante. No se modifica ni elimina gasto, intención o corrección financiera.
  Consultar «lo que se veía en una fecha pasada» no forma parte de este incremento.

Implementación y evidencia: [correcciones de Fase 1](reviews/PHASE1_EXPENSE_CORRECTIONS.md).

## 3. Presupuesto mensual

- Presupuestos por categoría y mes, sin arrastre del saldo. Configuración mensual opcional; si no se responde, copiar montos vigentes sin alterar periodos pasados.
- Alertar una vez por categoría/mes al cruzar 80 % y otra al 100 %; si pasa directamente al 100 %, notificar solo el 100 % en esa operación.
- Limitar avisos, no repetir; reiniciar flags el siguiente mes. No emitir notificaciones automáticamente desde el agente sin autorización de Jarvis.

### 3.1 Núcleo aprobado de Fase 1D — 2026-11-14

- Presupuesto explícito por instancia, sujeto, categoría y mes civil `YYYY-MM`;
  COP exacto. Categoría sin presupuesto devuelve ausencia, distinta de un límite
  de cero. No se crea el presupuesto del mes siguiente ni se arrastra saldo.
- **Decisión explícita del usuario sobre cero:** consumo cero no genera alertas;
  consumo positivo con límite cero genera solo el evento del 100 %. El porcentaje
  es no definido cuando el límite es cero o no existe presupuesto.
- El porcentaje se representa como fracción exacta `consumo * 100 / presupuesto`,
  con numerador y denominador `bigint`. No se redondea para decidir umbrales.
- Establecer un presupuesto con una intención nueva añade una revisión; la última
  revisión confirmada de esa categoría/mes es vigente. No borra las anteriores ni
  modifica gastos. Repetir una intención devuelve su revisión original, sin volver
  a hacerla vigente. Meses distintos permanecen independientes.
- El consumo utiliza únicamente gastos vigentes según su fecha civil. Anular o
  reemplazar actualiza las categorías/meses afectados dentro de la misma transacción.
  Presupuesto y consumo no son saldos de caja ni obligaciones pendientes.
- Establecer/revisar un presupuesto evalúa también el consumo ya registrado. Un
  gasto o corrección evalúa los periodos afectados una vez aplicada la operación
  completa, sin observar transitoriamente original y reemplazo juntos.
- Eventos internos persistidos al alcanzar/superar 80 % y 100 %, como máximo uno
  por umbral/categoría/mes/ámbito. Si ambos se alcanzan en una operación, solo 100 %.
  Un evento de 100 % suprime un aviso posterior de 80 % para ese mismo periodo.
  Correcciones, ajustes de presupuesto, reintentos y reinicios no borran ni reemiten
  eventos previos. Cada evento conserva presupuesto evaluado, consumo e intención
  que lo originó; representa evidencia histórica, no necesariamente consumo actual.
- Permisos `budget:write` y `budget:read`, revalidados antes de reintentos. Las
  intenciones comparten namespace con gastos/correcciones; cada servicio consulta
  solo resultados de su dominio. Ausencia en esa consulta no autoriza reutilizar
  una clave de otro dominio: la mutación sigue devolviendo conflicto.
- Presupuesto, intención y alertas se confirman juntos. Un fallo en alertas revierte
  también el gasto, corrección o presupuesto que las originaba.

La revisión mensual automática queda **pendiente**: un único mensaje al comenzar el
mes, reutilizar los últimos importes confirmados si no hay respuesta y permitir
ajustes conversacionales. Esto copia límites, nunca saldo disponible. Requiere
definir quién inicia el ciclo, zona horaria/calendario, plazo de respuesta,
confirmación, clave estable y deduplicación de entrega con la futura orquestación.
Este núcleo no envía mensajes, no programa tareas ni copia automáticamente límites.

Implementación y evidencia: [presupuestos mensuales](reviews/PHASE1_MONTHLY_BUDGETS.md).

## 4. Deudas financiadas

- Capturar valor, cuotas, monto de cuota, tasa efectiva anual si existe, calendario, saldo inicial conocido. Ausencia de tasa no bloquea el alta.
- Modo informado: amortización **estimada** separando capital/intereses, conciliación con extracto.
- Modo simplificado: saldo solo estimado; no confundir pago con amortización exacta.
- Deudas previas al onboarding: resumen inicial histórico sin contabilizar cuotas anteriores como gasto actual.
- Solo pagos **confirmados** reducen saldo; soportar parcial/total y fechas; sin recordatorios proactivos.

### 4.1 Deudas financiadas simplificadas — Fase 1F, 2026-11-15

Implementación autorizada del modo simplificado de la referencia original §4.
No modifica el documento histórico ni implementa amortización informada.

- Apertura explícita: descripción, valor financiado, número y valor nominal de
  cuotas, fecha civil de referencia, saldo conocido reportado y número de cuotas
  históricas pagadas. Dinero histórico desembolsado, tasa E.A. y condiciones son
  opcionales: ausencia significa desconocido, nunca cero ni un valor inferido.
- Las cuotas históricas se interpretan como las primeras N del plan. Se conserva
  el resumen, sin reconstruir importes/fechas individuales, crear gastos o salidas
  actuales ni descontar nuevamente ese dinero del saldo de referencia.
- Los datos de apertura son reportados por el actor autorizado, no verificados por
  un banco. La proyección siempre declara `balanceKind=estimated`; capital pendiente
  e intereses pagados permanecen desconocidos (`null`), incluso con tasa informada.
- La tasa se almacena como porcentaje E.A. decimal exacto no negativo, máximo seis
  decimales y 100 caracteres; ceros finales se normalizan. Cero informado es distinto
  de tasa ausente. No se redondea ni se convierte en tasa mensual. Condiciones se
  conservan como texto, sin interpretar cargos ni inventar una tabla de amortización.
- `confirmPayment` es la intención explícita de registrar un pago ya confirmado.
  Exige deuda, cuota concreta, importe positivo, fecha civil igual/posterior a la
  referencia y referencia textual. No es una instrucción para ejecutar un pago real.
  No se admiten borradores, un `confirmed=true` editable ni confirmación por calendario.
- Cada operación corresponde a una cuota posterior al resumen histórico. Se admiten
  abonos parciales; varios abonos confirmados pueden completar su importe nominal.
  No se asume FIFO ni se distribuye automáticamente un pago entre cuotas.
- El saldo estimado es saldo de referencia menos pagos confirmados desde esa apertura.
  Un pago confirmado es el único hecho de caja; la vista mensual de pagos de deuda
  lo reutiliza sin crear otro movimiento. No entra en consumo, presupuestos ni eventos
  de alertas. Esta vista de caja es específica de deudas, no un flujo global de caja.
- Exceso sobre saldo estimado devuelve y persiste `review_required` con motivo
  `EXCEEDS_ESTIMATED_BALANCE`. Exceso sobre remanente nominal de la cuota devuelve
  `EXCEEDS_INSTALLMENT_REMAINDER`. Ninguno modifica saldo/caja ni reparte excedentes.
  El historial distingue estos intentos de los pagos confirmados.
- Los resultados de revisión también son idempotentes: reintentar devuelve la
  decisión original aunque luego cambie el saldo. No se transforma silenciosamente
  una revisión en pago. Resolverla exige una futura decisión explícita; no hay flujo
  de conciliación o reasignación automática implementado.
- Las proyecciones nominales y el saldo pueden diferir. `requiresReview` señala
  saldo cero con cuotas pendientes, saldo positivo sin cuotas pendientes o dinero
  histórico reportado sin cuotas completas identificadas. Se conserva la apertura
  reportada sin inventar distribución ni dar por liquidada la deuda bancaria.
- Permisos `debt:write`, `debt:pay` y `debt:read`, ámbito vinculado fuera del payload,
  revalidación antes de replay y clave estable compartida con las otras mutaciones
  financieras. Referencia textual no equivale a un identificador bancario único;
  el origen debe conservar la misma clave ante reintentos.

Límites locales: 1–1200 cuotas, descripción de 1–200 caracteres, condiciones de
1–1000 y referencia de pago de 1–128, normalizadas sin controles internos. Importes
COP exactos, con límites operativos de SQLite existentes. No hay vencimientos
inferidos, recordatorios ni préstamos entre personas. Las correcciones de pagos
se incorporan mediante el incremento siguiente.
[Implementación y pruebas](reviews/PHASE1_FINANCED_DEBTS.md).

### 4.2 Correcciones de pagos — Fase 1G, 2026-11-15

- Una intención explícita y autorizada puede anular un pago confirmado vigente o
  reemplazarlo por un pago con importe, fecha, referencia o cuota corregidos.
  Requiere motivo; conserva actor, instante UTC de registro y vínculos de auditoría.
- La corrección subsana un registro equivocado. **No representa una devolución
  bancaria real**, ni crea ingreso, reembolso o movimiento negativo. Una devolución
  real requiere otro modelo todavía no implementado.
- El reemplazo es completo: cuota, importe positivo, moneda COP explícita, fecha
  civil y referencia. Permanece en la misma deuda; no se trasladan pagos entre deudas.
  Sigue respetando la fecha de referencia y el resumen histórico de cuotas.
- Original, respuesta idempotente y eventos permanecen inmutables. Solo se puede
  corregir un pago confirmado vigente, una vez de forma aplicada. Puede corregirse
  después su reemplazo vigente, formando una cadena. Un intento en revisión no es
  un pago confirmado que pueda anularse.
- Saldo estimado, progreso nominal de cuotas y caja mensual se calculan con pagos
  efectivos. `getDebt.payments` conserva todos los registros; `effectivePayments`
  identifica los confirmados vigentes. Un cambio de fecha mueve su contribución
  entre meses civiles; el momento de la corrección queda en el evento de auditoría.
- Antes de aplicar un reemplazo se retira hipotéticamente el original y se valida
  el candidato contra **todos** los otros pagos vigentes, incluidos los posteriores.
  Si supera saldo o remanente de cuota, se registra `review_required`, sin retirar
  el original, crear reemplazo, afectar caja ni repartir excedentes.
- La revisión conserva la propuesta y su decisión original. Ni pagos ni correcciones
  antiguas en revisión se promueven automáticamente al cambiar la capacidad disponible.
  Una petición distinta tras revisar requiere una intención nueva; no sobrescribe la
  decisión anterior ni activa un proceso automático de resolución.
- Mismo key/contenido devuelve el evento original antes de reevaluar vigencia;
  contenido diferente produce conflicto. Dos correcciones aplicadas del mismo pago
  se excluyen transaccionalmente. Comparte namespace de intención financiera.
- Permiso `debt:correct` para mutar y `debt:read` para consultar auditoría/intención,
  vinculados a instancia/sujeto y revalidados antes de replay. Un ID ajeno es inexistente.
- No se recalculan ni sobrescriben saldos guardados como evidencia de decisiones
  anteriores; la consulta vigente se reconstruye de la historia. El saldo sigue
  siendo estimado, sin inferir capital, intereses o comisiones.
- La corrección no crea gastos ordinarios ni alertas presupuestarias o de vencimiento.

[API, migración y evidencia](reviews/PHASE1_DEBT_PAYMENT_CORRECTIONS.md).

## 5. Facturas y gastos fijos

- Crear obligación mensual por concepto y periodo, inicialmente pendiente.
- Importe variable estimado: último valor efectivamente pagado. Al recibir factura real, conciliar; no declarar pagado por fecha prevista.
- Varias mensualidades impagas coexisten y se suman; asociar pagos a mes exacto, preguntar si ambiguo.
- Servicios: pago completo en primera versión; otras deudas/préstamos sí admiten abonos parciales.

### 5.1 Gastos fijos y facturas — Fase 1I, 2026-11-16

Implementa la referencia original §5 con generación **explícita**, por autorización
del usuario. La generación automática queda pendiente de orquestación.

- Concepto estable e inmutable: descripción, categoría existente y COP. Puede
  tener importe fijo habitual y regla de vencimiento opcionales. Un importe fijo
  configura una estimación, no confirma automáticamente una factura.
- Vencimiento habitual exige día 1–31 y desplazamiento explícito: 0 para el mes
  facturado, 1 para el siguiente. Se ajusta al último día existente cuando sea
  necesario. Sin ambos datos no se infiere vencimiento. Cada obligación puede
  indicar una fecha concreta o `null` para ausencia explícita.
- `generateObligation` requiere concepto, periodo `YYYY-MM` y fecha civil
  `generatedOn`. Solo una obligación por concepto/mes/ámbito; varias mensualidades
  pendientes coexisten. Reintentar la misma intención devuelve el original; otra
  intención para el mismo periodo produce `BILL_OBLIGATION_EXISTS`.
- Importe desconocido es `null`, distinto de cero, estimado y confirmado. Los
  importes conocidos son positivos. Si se suministra importe explícito también
  se exige indicar `estimated` o `confirmed`; nunca se adivina el estado.
- Sin importe explícito, un concepto fijo usa su base como estimación. Un concepto
  variable usa el último pago confirmado conocido con fecha de pago no posterior
  a `generatedOn`: mayor fecha civil y, en empate, último registro durable. Si no
  existe, queda desconocido. No se usan facturas pendientes como fuente.
- La estimación conserva su pago fuente. Pagos registrados después no recalculan
  obligaciones ya generadas. Cada obligación y cada revisión son inmutables.
- `adjustObligation` permite confirmar/ajustar importe antes de pagar, con motivo,
  actor, instante UTC y `expectedRevisionId`. La revisión inicial es el ID de la
  obligación; después es el ID del último ajuste. Una revisión obsoleta produce
  `BILL_REVISION_CONFLICT`, sin consumir la intención.
- `confirmPayment` exige obligación concreta, revisión vigente confirmada, importe
  efectivo exactamente igual al confirmado, fecha civil y referencia. No admite
  pagos parciales ni asignación ambigua de un concepto a varios meses. La fecha
  de pago debe ser igual/posterior a la fecha civil de generación informada.
  Un importe distinto requiere ajustar primero; un estimado debe confirmarse.
- **Decisión aprobada por el usuario:** solo el pago confirmado contribuye al
  consumo y presupuesto, por su fecha civil de pago. Una factura de noviembre
  pagada en diciembre afecta caja y presupuesto de diciembre. Conserva noviembre
  como periodo de obligación. Generar o ajustar una obligación no crea consumo,
  salida de caja ni alerta presupuestaria.
- El pago comparte ID con un único gasto existente (`expenseId = id`). Su vista
  de caja y su contribución a consumo reutilizan ese hecho; no deben sumarse como
  movimientos diferentes. Gasto, vínculo a obligación, intención y alertas se
  confirman en la misma transacción. Las reglas previas de alertas 80/100 permanecen.
- Un segundo pago con otra clave se rechaza como `BILL_ALREADY_PAID`; reintentar la
  intención original devuelve el mismo pago. Después del pago no se ajusta la
  factura. Se bloquea también anular/reemplazar aisladamente su gasto vinculado
  (`BILL_PAYMENT_CORRECTION_REQUIRED`): la corrección conjunta queda pendiente.
- `getObligation` conserva obligación original, revisiones, versión vigente y pago.
  `listObligations` admite fecha explícita `asOf` y filtro de concepto; distingue
  pagadas, pendientes y vencidas. Un pago posterior a la consulta aún no liquida
  el periodo en esa vista. Se excluyen generaciones posteriores a `asOf`; los
  importes usan las revisiones actualmente conocidas, no auditoría temporal.
- El vencimiento es inclusivo: vencida desde el día siguiente si no está pagada.
  Sin vencimiento permanece pendiente. Totales confirmados y estimados se separan;
  importes desconocidos se cuentan, no se tratan como cero. Los vencidos son un
  subconjunto de los pendientes, no otro importe que se les deba sumar.
- Permisos `bill:write` para concepto/generación/ajuste, `bill:pay` para confirmar
  pago y `bill:read` para consultas, incluidos reintentos autorizados. Contexto
  actor/sujeto/instancia vinculado fuera del payload. Idempotencia global por ámbito;
  referencia textual no es una clave bancaria ni sustituye la intención estable.

No hay programación automática, recordatorios, pagos parciales, edición de
conceptos, cancelación de obligaciones ni correcciones de pagos vinculados.
La integración y orquestación futura se describen en
[el informe del incremento](reviews/PHASE1_RECURRING_BILLS.md).

## 6. Salario y cuentas por cobrar

- Configurar salario **neto** y vigencia histórica. Cierre de mes: generar salario esperado, no saldo disponible.
- Límite de pago por defecto día 5 del mes siguiente; desde día 6, pendientes vencidos.
- Abonos recibidos parciales se aplican FIFO al mes salarial más antiguo; excedentes requieren confirmación.
- Respuesta al abono breve, sin anunciar espontáneamente saldos; consultas a demanda.

### 6.1 Núcleo salarial — Fase 1H, 2026-11-15

Implementa el alcance salarial de la referencia original §6 con datos sintéticos.
La decisión explícita del usuario limita las vigencias al primer día del mes;
no se calcula prorrateo ni se reconstruye todo el historial laboral.

- `configureSalary`: salario neto mensual COP positivo y vencimiento habitual de
  1 a 31, por defecto 5. Cada vigencia es inmutable y única por ámbito/fecha.
  Los cierres conservan importe, vencimiento y versión aplicada. Se rechaza una
  nueva vigencia en o antes de un mes ya cerrado; ajustar periodos históricos
  requerirá un futuro flujo auditable, nunca una edición silenciosa.
- `importPendingPeriod`: registra individualmente un saldo pendiente reportado por
  mes, importe, fecha civil de corte (`asOf`) y día de vencimiento. No presupone
  que ese importe sea todo lo devengado ni inventa pagos anteriores. La apertura
  no genera caja. No existe importación masiva ni límite arbitrario de antigüedad;
  la selección de periodos recientes es explícita durante onboarding.
- `closePeriod`: exige cierre explícito con `month` y `closedOn` igual/posterior al
  último día del mes. Toma la última vigencia aplicable al inicio de ese mes y
  crea una obligación por cobrar. No genera caja. Un solo periodo por mes/ámbito,
  sea apertura o cierre; misma intención devuelve el original y otra clave para
  ese mes produce `SALARY_PERIOD_EXISTS`.
- La obligación cerrada corresponde al último día del mes trabajado, aunque el
  cierre se registre después. Una apertura reportada está disponible desde su
  fecha de corte, sin extrapolar su saldo a fechas anteriores. El vencimiento
  siempre cae en el mes siguiente al trabajado; los días 29–31 se ajustan al
  último día de ese mes cuando no existan. El día límite es inclusivo: el saldo
  pendiente se clasifica vencido desde el día siguiente.
- `receivePayment` registra dinero **ya recibido y confirmado**, con fecha civil,
  importe positivo, referencia y clave estable. Distribuye automáticamente FIFO
  entre los periodos elegibles pendientes; puede cubrir varios meses. El recibo
  confirmado es el único hecho de entrada de caja. Las asignaciones son vínculos
  contables, no ingresos adicionales ni gastos/consumo/eventos presupuestarios.
- Si supera lo pendiente elegible, persiste `review_required` con motivo
  `EXCEEDS_PENDING_BALANCE`, sin aplicar siquiera una parte ni crear caja. Resolver
  el excedente sigue pendiente; no se promueve un intento en revisión al cambiar
  los saldos. Reintentar conserva la decisión original.
- Límite conservador inicial: un abono anterior al último abono confirmado queda
  en revisión `PAYMENT_DATE_REQUIRES_REVIEW`. Importar/cerrar un mes igual o anterior
  al último periodo ya asignado exige revisión (`SALARY_PERIOD_REQUIRES_REVIEW`),
  sin consumir la intención. Esto evita reinterpretar FIFO histórico; el flujo de
  revisión/corrección retroactiva no está implementado. Cargar los pendientes de
  apertura antes de registrar sus abonos. Abonos del mismo día se ordenan por registro.
- `getReceivables({asOf})` separa devengado por cierres (`closedEarned`), pendientes
  reportados en apertura (`openingReceivable`), recibido, pendiente y vencido.
  La consulta usa fecha civil explícita y hechos actualmente conocidos; no simula
  qué información conocía la aplicación en un instante histórico de auditoría.
  `getPayment` revela asignaciones a demanda; `monthlyCashInflow` muestra solo
  entradas salariales confirmadas, no es un flujo global de caja.
- La respuesta al abono contiene únicamente el recibo/estado, sin saldos pendientes
  ni asignaciones espontáneas. Conserva actor e instante UTC de auditoría; estos
  no determinan el mes financiero. Referencia textual no es un identificador
  bancario único: el consumidor debe conservar la misma clave ante incertidumbre.
- Permisos `salary:configure`, `salary:close` (también apertura), `salary:receive`
  y `salary:read`, con actor/sujeto/instancia vinculados fuera del payload. Replay
  revalida autorización y conserva el actor original, incluso si otro actor del
  mismo ámbito está autorizado. Claves compartidas con todas las mutaciones previas.

Un único flujo salarial lógico por sujeto/instancia; no se captura identidad real
ni se soportan varios empleadores. Sin scheduler, recordatorios, ingresos
extraordinarios, conciliación bancaria o correcciones de recibos salariales.
[Implementación y evidencia](reviews/PHASE1_SALARY_RECEIVABLES.md).

## 7. Préstamos personales

- Registrar dinero prestado a terceros y dinero recibido en préstamo con contraparte libre; agregar saldos por dirección.
- Conservar desembolsos y abonos individuales. Capital recibido/prestado no se considera ingreso ganado/gasto de consumo; distinguir caja y activo/pasivo.
- Pagos parciales/total, nunca duplicar ni inferir persona o dirección.

### 7.1 Préstamos entre personas — Fase 1J, 2026-11-16

Implementa el alcance de la referencia original §7 con fixtures sintéticas.

- `createCounterparty` registra nombre e ID estable. El nombre no es una clave
  única: dos personas con igual nombre mantienen identidades y saldos distintos.
  No se codifican parentescos ni nombres específicos en las reglas.
- Dirección obligatoria: `receivable` («me deben») y `payable` («le debo»).
  Cada contraparte mantiene ambas posiciones independientes; nunca se compensan.
- `recordDisbursement` registra capital efectivamente prestado/recibido, con fecha
  civil, importe positivo COP y referencia. Admite varios desembolsos por persona
  y dirección, conservando cada movimiento. No crea gasto, salario ni alerta.
- `recordRepayment` registra devolución confirmada parcial o total de capital.
  Se aplica al saldo agregado de esa persona/dirección; no se inventa una
  asignación a desembolsos individuales, calendario, interés o comisión.
- Efectos de caja: recibir préstamo aumenta pasivo y entrada; prestar aumenta
  cuenta por cobrar y salida; recibir devolución reduce cuenta por cobrar y
  genera entrada; devolver reduce pasivo y genera salida. Ninguno es ingreso
  ganado ni consumo. Cada movimiento confirmado es el único hecho de caja.
- Un abono superior al pendiente produce `review_required` con motivo
  `EXCEEDS_PENDING_BALANCE`, sin efecto de caja ni reducción parcial del saldo.
  El resultado de revisión es durable e idempotente. No se reactiva al registrar
  después más capital; resolverlo requiere revisión explícita y otra intención.
- Para abonos retroactivos se comprueba que el saldo no sea negativo en ningún
  punto de la historia civil de esa contraparte/dirección, incluidos los pagos
  posteriores. Se desempata por orden durable de registro en el mismo día.
  Un abono que cabe en el saldo total pero rompe esa condición queda en revisión
  `PAYMENT_DATE_REQUIRES_REVIEW`. Un desembolso retroactivo puede registrarse
  porque solo agrega capital; no modifica decisiones anteriores.
- `principalBalanceAfter` conserva el saldo total de capital conocido al decidir
  el movimiento, no un saldo bancario verificado ni necesariamente el saldo a su
  fecha retroactiva. `getPosition({counterpartyId,direction,asOf})` calcula el saldo
  a una fecha civil explícita, sumando únicamente confirmados elegibles. Conserva
  también intentos en revisión en el historial, identificados sin efecto financiero.
- `listPositions({asOf})` presenta saldos por persona y totales por dirección,
  sin netear. Incluye las contrapartes conocidas aunque aún no tengan movimientos
  elegibles. `monthlyCashFlow({month})` presenta entradas y salidas de préstamos
  confirmadas, usando los mismos IDs; no es un consolidado global de caja.
- Consultas a fecha usan hechos actualmente conocidos; no reconstruyen lo que
  la aplicación conocía en un instante de auditoría. `recordedAt` conserva instante
  UTC de registro; `occurredOn` determina la fecha financiera, sin reloj implícito.
- Permisos `loan:counterparty`, `loan:disburse`, `loan:repay` y `loan:read`, con
  actor/sujeto/instancia vinculados fuera del payload. Autorización previa a toda
  lectura y replay. La clave comparte namespace financiero con los otros módulos;
  mismo contenido devuelve el resultado original, distinto contenido es conflicto.
- El libro, las contrapartes, las revisiones y sus intenciones son inmutables.
  Referencia textual no es ID bancario único: otra clave representa otra intención,
  aunque los datos coincidan. Ante respuesta incierta se consulta la misma clave.

Sin intereses, vencimientos inferidos, recordatorios, mensajes a terceros,
correcciones de préstamos, edición/fusión de contrapartes ni compensaciones.
[Informe, contrato y evidencia](reviews/PHASE1_PERSONAL_LOANS.md).

## 8. Suscripciones compartidas

- Toda suscripción mensual crea pendiente; solo confirmar pago real.
- Si se confirma pago total de suscripción compartida: salida de caja total, gasto personal de la participación propia, cuenta por cobrar de otros; división igualitaria.
- Cambios de participantes afectan periodos futuros. Reembolsos FIFO por antigüedad; no son ingreso ganado.
- Sin cobranza automática a terceros ni recordatorios de vencimientos.

## 9. Comprobantes

- Opcionales; guardar solo archivos enviados. Imagen sin contexto → borrador y confirmación; ilegible → nunca inventar importe.
- Almacenamiento privado, vínculo con movimiento, acceso limitado por sujeto. Buscar por fecha, importe, categoría, contraparte y devolver archivo original.
- Revisión semestral con oferta de backup ZIP + índice CSV; **sin borrado automático**, requerir consentimiento explícito.

## 10. Ingresos extraordinarios de apuestas

- Registrar retiros y recargas comunicados, sin detalle de cada apuesta y sin recomendaciones para apostar.
- Ganancia estimada = retiro - recargas vinculadas, con advertencia por movimientos omitidos. Evitar doble registro de transferencia desde plataformas.

## 11. Monedas y cambio

- ISO 4217; COP por defecto. Guardar monto original, moneda, fecha, tasa histórica, fuente y estimación convertida.
- Valor real bancario confirmado prevalece en las vistas; preservar histórico estimado; no recalcular a tasa actual.
- Redondeo documentado por moneda. Nunca usar aritmética binaria de punto flotante para dinero.

## 12. IA, privacidad y presupuesto

- La IA (si posteriormente se autoriza) interpreta mensajes; dominio valida y escribe de forma determinista. Nunca enviar datos reales a proveedor no habilitado.
- BYOK; proveedores y rutas sujetos a política de privacidad efectiva, costes y presupuestos. Sin modelos locales al inicio según acuerdos; no conectar ninguno en Fase 0.
- Si no hay proveedor seguro o presupuesto, fallar con mensaje claro. Sin cargos automáticos.

## 13. Notificaciones

- Permitidas por defecto: revisión mensual de presupuesto, 80/100 % una vez, revisión semestral de comprobantes.
- Prohibido emitir recordatorios automáticos de cuotas, facturas o salario vencido sin autorización explícita.
- Don Gastón propone eventos; Jarvis decide canal, preferencias, deduplicación de entrega.

### 13.1 Consulta y reconocimiento local — Fase 1E, 2026-11-14

- Se reutilizan los IDs de alertas ya persistidas. La proyección v1 expone solo
  tipo, ID, categoría, mes y umbral; no importes, nombres, actor ni intención origen.
- Consulta de pendientes por instancia/sujeto, orden durable y páginas de 1–100
  elementos (50 por defecto). Cursor opaco autenticado y cifrado, vinculado al
  ámbito y a un límite superior estable de recorrido. Consultar no modifica estados.
- Reconocimiento explícito de procesamiento con permiso `event:ack`; consulta con
  `event:read`. Son permisos distintos de gastos/presupuestos y se revalidan siempre.
  Un reconocimiento no prueba entrega de un mensaje a un canal ni lectura del usuario.
- Un consumidor lógico por instancia/sujeto, con posibles procesos concurrentes.
  Sin reservas temporales. El primer reconocimiento confirma un registro durable;
  repetir el mismo ID devuelve su recibo original, sin nuevos efectos.
- Entrega **al menos una vez**: la futura contraparte debe deduplicar duraderamente
  por ámbito/ID y reconocer después de procesar. Ante interrupción se puede comenzar
  sin cursor; avanzar una página no reconoce sus eventos. Nuevos eventos posteriores
  al límite de recorrido aparecen en el siguiente recorrido.
- Reconocimientos separados de hechos financieros y alertas, sin modificar su
  historia. No se revocan automáticamente cuando cambia el consumo presupuestario.

Contrato local versionado: [consulta y reconocimiento v1](EVENT_DELIVERY_CONTRACT_V1.md).
No está cotejado con Jarvis. No hay API pública, canal, scheduler ni entrega real.

## 14. Fuera de alcance y cuestiones abiertas

- Sin importación masiva Excel, banca abierta, pagos/transferencias, manejo automático de apuestas, app móvil, WhatsApp, sincronización bancaria ni múltiples sujetos por instancia en MVP.
- SQLite local aislado aprobado en ADR-001 exclusivamente para datos sintéticos. Pendiente: licencia; hosting; cifrado/rotación; formato definitivo de protocolo; proveedor IA; condiciones de protección y retención; política operativa de copias y restauración; aprobación de escrituras reales.

## Reglas transversales de seguridad financiera

1. Identidad financiera: `subject_ref` **vinculado** desde Jarvis, nunca aceptado a ciegas en el cuerpo del mensaje.
2. Mutaciones idempotentes: clave de intención estable + huella de payload + unicidad y transacción. Mismo ID y mismo payload devuelven resultado almacenado; mismo ID con payload diferente ⇒ conflicto. Incertidumbre ⇒ consultar primero.
3. Auditoría append-only/reversiones por compensación; cambios de saldo deben tener origen.
4. No falsificar prueba de funcionalidad con mocks presentados como producción. Fixtures sin nombres, teléfonos, recibos ni saldos verdaderos.
