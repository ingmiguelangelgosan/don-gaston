# Matriz de pruebas sintéticas

Fecha: 2026-11-08. Responsable: `test_engineer`.

Fuentes: `PRODUCT_RULES.md`, `TRACEABILITY.md`, `ROADMAP.md` y encargo del coordinador. Esta matriz diseña casos; no certifica su implementación. El especialista no ejecutó tests ni scripts npm. La evidencia de ejecución del bootstrap corresponde al coordinador y al README final.

## Fase 0: bootstrap local

Todos los importes de ejemplo son inventados. Representar unidades menores con `bigint`; no convertir a `number`. La moneda del ejemplo es COP. Estos ejemplos no implementan un ledger, política general de redondeo ni soporte multimoneda. No se requieren nombres, cuentas, recibos, credenciales, servicios ni tráfico externo.

| ID | Caso y condición inicial | Acción | Resultado esperado | Tipo | Riesgo cubierto | Fase / estado |
|---|---|---|---|---|---|---|
| BOOT-01 | Configuración local sintética válida | Validar y arrancar | Arranque finaliza correctamente sin iniciar servidor ni integración | Unidad e integración local | Ampliación accidental de alcance | 0 / diseñado; ejecución por coordinador |
| BOOT-02 | Modo de operación distinto al permitido | Validar configuración | Rechazo explícito antes de arrancar | Unidad negativa | Operación real accidental | 0 / diseñado; ejecución por coordinador |
| BOOT-03 | Valor inválido que contiene marcador sintético `PRIVATE_SENTINEL_TEST` | Capturar error de configuración | Mensaje identifica campo o error seguro y no reproduce el marcador ni el entorno completo | Unidad negativa | Fuga de configuración | 0 / diseñado; ejecución por coordinador |
| BOOT-04 | Variables opcionales ausentes y entradas vacías | Validar según contrato de configuración documentado | Defaults seguros para ausentes; vacíos no habilitan operaciones externas | Unidad de límites | Defaults inseguros | 0 / diseñado; ejecución por coordinador |
| FIN-M01-EX | `9007199254740993n` unidades menores | Sumar `1n` | Exactamente `9007199254740994n`, sin paso por float | Ejemplo unitario | Pérdida de precisión sobre límite seguro JS | 0 / ejemplo diseñado |
| FIN-M02-EX | Suscripción sintética de `12000n` unidades menores, tres participantes | Comparar proyecciones predefinidas del mismo hecho | Caja: salida `12000n`; consumo propio: `4000n`; cuenta por cobrar: `8000n`. No sumar caja y consumo como un gasto de `16000n` | Ejemplo unitario con fixture | Confundir flujo de caja y consumo | 0 / ejemplo diseñado |
| BOOT-05 | Instalación desde lockfile revisado | Ejecutar comandos de formato, lint, typecheck, build y tests declarados por coordinador | Cada comando termina con código 0; registrar número real de tests y runtime | Verificación local | Bootstrap no reproducible | 0 / pendiente de evidencia del coordinador |

El ejemplo de suscripción usa una división exacta deliberadamente. El tratamiento de remanentes en divisiones no exactas necesita una política aprobada; no se deduce de este ejemplo. Un fixture de proyecciones no prueba deduplicación ni consistencia transaccional.

## Casos posteriores: fuera de implementación de Fase 0

Los siguientes casos están **pendientes, no implementados ni ejecutados por esta revisión**. Los IDs base mantienen correspondencia con `TRACEABILITY.md`. Las fases indican la primera etapa relevante; las garantías transaccionales requieren el almacenamiento aprobado y sus pruebas correspondientes.

| ID | Caso y condición inicial | Acción | Resultado esperado | Tipo futuro | Riesgo | Fase |
|---|---|---|---|---|---|---|
| FIN-M01 | Importes textuales válidos e inválidos, COP y otras monedas ISO | Parsear, operar y representar | Exactitud, rechazo de formatos inválidos y monedas no soportadas; redondeo acorde con decisión documentada | Unidad parametrizada | Corrupción monetaria | 1 |
| FIN-M02 | Hecho financiero con identidad estable y proyecciones | Registrar consumo y posterior pago de obligación | Caja y consumo separados; no duplicar gasto ni hecho | Unidad; integración transaccional posterior | Doble conteo | 1–2 |
| FIN-I01 | Intención estable ya procesada | Repetir misma clave y payload | Mismo resultado almacenado, un solo efecto | Unidad simulada; integración posterior | Reintentos duplicados | 1–2 |
| FIN-I02 | Clave ya asociada a una huella | Repetir clave con importe o moneda diferente | Conflicto sin mutación adicional; código de transporte según contrato aprobado | Unidad; integración | Cambio silencioso de intención | 1–2 |
| FIN-I03-A | Fallo inyectado antes del commit | Reintentar con misma clave | Ningún efecto parcial; resultado consistente al completar | Integración con fallo controlado | Estado parcial | 2 |
| FIN-I03-B | Commit completo, respuesta perdida | Consultar estado y reintentar misma clave | Recuperar resultado previo, sin generar clave nueva ni duplicar | Integración con fallo controlado | Incertidumbre tras commit | 2 |
| FIN-I04 | Dos solicitudes idénticas liberadas por barrera determinista | Ejecutar concurrentemente | Un commit y resultado consistente por unicidad transaccional | Integración | Carrera entre solicitudes | 2 |
| FIN-A01 | Actor autenticado ligado a sujeto e instancia A | Solicitar acción sobre B o manipular `subject_ref` editable | Denegar antes de lectura/escritura y sin filtrar datos de B | Unidad de autorización; contrato posterior | Acceso cruzado | 1 y 4 |
| FIN-C01 | Imagen sintética sin contexto o pago ambiguo | Interpretar solicitud | Borrador pendiente; no confirmar importe ni registrar pago | Unidad con adaptador falso | Confirmación inventada | 2–3 |
| FIN-D01 | Deuda sintética con saldo estimado | Proponer pago; luego confirmar abono parcial | Propuesta no reduce obligación; confirmado reduce según modelo; estimación identificada | Unidad | Pago supuesto y amortización falsa | 2 |
| FIN-S01 | Dos salarios pendientes de periodos sucesivos | Aplicar abono parcial y luego excedente | FIFO al más antiguo; excedente requiere decisión; esperado no aumenta caja | Unidad | Mezcla de devengo y cobro | 2 |
| FIN-B01 | Presupuesto sintético y reloj fijo | Cruzar 80 %, repetir, cruzar 100 %, saltar directamente de menos de 80 a 100 | Una propuesta por umbral/periodo; salto directo solo 100; reinicio en siguiente periodo | Unidad | Duplicación de avisos | 2 |
| FIN-N01 | Cuotas, facturas y salarios vencidos sin autorización | Avanzar reloj de prueba | Ningún recordatorio automático de vencimiento | Unidad con colector falso | Avisos no consentidos | 2 |
| FIN-F01 | Dos facturas mensuales impagas | Registrar factura real y proponer pago ambiguo | Conservar ambas obligaciones; conciliar estimación; pedir periodo, sin pago supuesto | Unidad | Pérdida de obligaciones | 2 |
| FIN-L01 | Préstamo recibido y préstamo otorgado sintéticos | Registrar desembolso y abono | Caja y activo/pasivo coherentes; capital no es ingreso ganado ni consumo | Unidad | Clasificación incorrecta | 2 |
| FIN-SH01 | Suscripción compartida pagada y dos meses por cobrar | Recibir reembolso y cambiar participantes | Reembolso FIFO sin ingreso ganado; cambio afecta futuro | Unidad | Ingreso ficticio e historia alterada | 2 |
| FIN-H01 | Evento en periodo cerrado | Corregir importe | Compensación o historia auditable; no sobrescritura silenciosa | Unidad e integración | Pérdida de auditoría | 2 |
| FIN-R01 | Archivo sintético privado asociado a sujeto A | Buscar desde B; vencer acceso temporal; solicitar limpieza sin consentimiento | Acceso negado; enlace vencido no sirve; archivo permanece sin confirmación explícita | Integración con almacenamiento de prueba | Exposición o borrado | 3 |
| FIN-BK01 | Dataset sintético con eventos y claves de idempotencia | Copiar y restaurar en entorno aislado; probar copia corrupta | Integridad demostrada, reintentos siguen deduplicados; corrupción falla de forma segura; medir RPO/RTO | Integración local controlada | Pérdida o duplicación tras recuperación | 3 |
| FIN-P01 | Proveedor no aprobado y adaptador falso con contador | Solicitar interpretación | Cero invocaciones externas; fallo seguro | Unidad | Exfiltración y coste | Cuando se autorice diseño IA |

## Reproducibilidad y límites

- Usar IDs inventados (`synthetic-intent-001`, `synthetic-subject-A`) y reloj fijo; no depender de fecha actual, aleatoriedad no controlada ni latencia.
- Inyectar fallos y usar barreras explícitas para concurrencia; no basar aserciones en esperas arbitrarias.
- No simular una restricción única y presentarla como prueba de base de datos: demostrar atomicidad después de aprobar e implementar almacenamiento.
- Revisar el contenido de los scripts antes de ejecutarlos. Esta revisión solo ejecutó lectura documental y creación de este informe.
- Cierre de Fase 0: comandos locales exitosos documentados y ejemplos sintéticos reproducibles. Los casos futuros no bloquean el scaffold, pero sí las capacidades que dependan de ellos.
