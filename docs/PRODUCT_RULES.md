# Don Gastón — reglas de negocio (v0.1, trasladadas a agente independiente)

**Estado:** requisitos de producto para implementar; **nada de esto está implementado por el kit documental**. Base: acuerdos registrados el 2026-11-01 en `REFERENCIA_FUNCIONAL_JARVIS_2026-11-01.md`, conservada íntegra. Don Gastón recibe intenciones estructuradas y responde resultados a Jarvis; no opera Telegram ni se apropia del canal. Si hay discrepancia con la referencia, documentar y pedir autorización.

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

## 3. Presupuesto mensual

- Presupuestos por categoría y mes, sin arrastre del saldo. Configuración mensual opcional; si no se responde, copiar montos vigentes sin alterar periodos pasados.
- Alertar una vez por categoría/mes al cruzar 80 % y otra al 100 %; si pasa directamente al 100 %, notificar solo el 100 % en esa operación.
- Limitar avisos, no repetir; reiniciar flags el siguiente mes. No emitir notificaciones automáticamente desde el agente sin autorización de Jarvis.

## 4. Deudas financiadas

- Capturar valor, cuotas, monto de cuota, tasa efectiva anual si existe, calendario, saldo inicial conocido. Ausencia de tasa no bloquea el alta.
- Modo informado: amortización **estimada** separando capital/intereses, conciliación con extracto.
- Modo simplificado: saldo solo estimado; no confundir pago con amortización exacta.
- Deudas previas al onboarding: resumen inicial histórico sin contabilizar cuotas anteriores como gasto actual.
- Solo pagos **confirmados** reducen saldo; soportar parcial/total y fechas; sin recordatorios proactivos.

## 5. Facturas y gastos fijos

- Crear obligación mensual por concepto y periodo, inicialmente pendiente.
- Importe variable estimado: último valor efectivamente pagado. Al recibir factura real, conciliar; no declarar pagado por fecha prevista.
- Varias mensualidades impagas coexisten y se suman; asociar pagos a mes exacto, preguntar si ambiguo.
- Servicios: pago completo en primera versión; otras deudas/préstamos sí admiten abonos parciales.

## 6. Salario y cuentas por cobrar

- Configurar salario **neto** y vigencia histórica. Cierre de mes: generar salario esperado, no saldo disponible.
- Límite de pago por defecto día 5 del mes siguiente; desde día 6, pendientes vencidos.
- Abonos recibidos parciales se aplican FIFO al mes salarial más antiguo; excedentes requieren confirmación.
- Respuesta al abono breve, sin anunciar espontáneamente saldos; consultas a demanda.

## 7. Préstamos personales

- Registrar dinero prestado a terceros y dinero recibido en préstamo con contraparte libre; agregar saldos por dirección.
- Conservar desembolsos y abonos individuales. Capital recibido/prestado no se considera ingreso ganado/gasto de consumo; distinguir caja y activo/pasivo.
- Pagos parciales/total, nunca duplicar ni inferir persona o dirección.

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

## 14. Fuera de alcance y cuestiones abiertas

- Sin importación masiva Excel, banca abierta, pagos/transferencias, manejo automático de apuestas, app móvil, WhatsApp, sincronización bancaria ni múltiples sujetos por instancia en MVP.
- Pendiente: licencia; DB; hosting; cifrado/rotación; formato definitivo de protocolo; proveedor IA; condiciones de protección y retención; política de copias y restauración; aprobación de escrituras reales.

## Reglas transversales de seguridad financiera

1. Identidad financiera: `subject_ref` **vinculado** desde Jarvis, nunca aceptado a ciegas en el cuerpo del mensaje.
2. Mutaciones idempotentes: clave de intención estable + huella de payload + unicidad y transacción. Mismo ID y mismo payload devuelven resultado almacenado; mismo ID con payload diferente ⇒ conflicto. Incertidumbre ⇒ consultar primero.
3. Auditoría append-only/reversiones por compensación; cambios de saldo deben tener origen.
4. No falsificar prueba de funcionalidad con mocks presentados como producción. Fixtures sin nombres, teléfonos, recibos ni saldos verdaderos.
