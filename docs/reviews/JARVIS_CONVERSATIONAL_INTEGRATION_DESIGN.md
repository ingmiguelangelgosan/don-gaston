# Fase 2D — diseño de integración conversacional con Sir Jarvis

Fecha: 2026-11-17. **Análisis y propuesta para aprobación; no implementado.**
Único entregable nuevo de este incremento. No se modificaron código, contratos,
configuración ni datos de Jarvis o Don Gastón. No se crearon simuladores ni bases.
Las 34/34 pruebas de Fase 2C y Node 24.22.3 son evidencia histórica, no una prueba
del bot financiero ni verificaciones repetidas en esta fase documental.

## 1. Arquitectura real observada

Jarvis inspeccionado en lectura: `D:/Documentos/sir-jarvis`, HEAD
`c015c4e02908676fa8f87fc7bf524580169bb578`; las rutas fuente inspeccionadas no
presentaron diff frente a HEAD. Don Gastón: HEAD
`97bd4e0c50fdb0a5e1ab5bc22ec649a49dd37d76`, con cambios locales de Fase 2C
ya presentes y conservados. Referencias de línea siguientes corresponden al
checkout observado; deben revalidarse antes de implementar.

| Pieza real en Jarvis | Evidencia y consecuencia |
|---|---|
| `src/channels/telegram/polling.ts:44` | Construye `createTelegramHandler`; usa `getMe/getUpdates`, ordena updates y conserva offset mediante journal. Puede ejercitarse con `TelegramApi` de pruebas sin red Telegram. |
| `src/channels/telegram/handler.ts:16`, `:110` | Valida mensaje privado, usuario no bot, allowlist, chat igual a remitente y ausencia de sender_chat. Esta frontera debe preceder a cualquier preparación financiera. |
| `handler.ts:122`, `:153` | Solo clasifica como acciones de agentes los comandos reconocidos por `isTelegramAgentCommand`; texto libre y «sí» no alcanzan el servicio de agentes. Cambiar solo el callback no basta: también hay que enrutar y reservar durablemente la nueva interacción. |
| `src/channels/telegram/agent-commands.ts:20`, `:25` | Reconoce `/agents` y `/agent`; crea actor a partir de binding administrado usuario→sujeto. Deriva IDs HMAC por bot/chat/message, no del texto libre. Un segundo mensaje «sí» tendría otro messageId: no se puede usar para crear otra intención financiera. |
| `src/app/agent-read.ts:40` | `supported()` limita expresamente a efecto read, `echo.reply` 1.0 y schemas demo. No es un ejecutor financiero genérico. Conservar ese límite en `/agent`. |
| `src/app/telegram-agents.ts:82`, `:151`, `:169` | Parsea configuración estricta, valida bindings y compone Registry/transporte. El catálogo solo registra `demo.input.v1` y `demo.output.v1`: los schemas financieros no están incluidos aquí. |
| `telegram-agents.ts:217`, `:232`, `:243` | Vincula instalación/clave/sujetos al store; selecciona Gateway durable si recibe store y crea `AgentReadService`. La futura escritura deberá exigir store durable y una ruta separada de lectura. |
| `src/app/agent-execution.ts:38`, `:47` | `AgentExecutionService` valida actor externo, lo compara con instancia/sujeto del request y autoriza contra Registry antes de ejecutar. Reutilizable sin inventar otra interfaz wire. |
| `src/channels/telegram/durable-actions.ts:24` | `createDurableTelegramJournal` reserva acciones con HMAC, guarda fases de resultado/entrega y offset; no guarda el borrador ni consentimiento del humano. `result-confirmed` significa respuesta procesada, **no aceptación financiera**. |
| `src/agents/state-store.ts:15`, `:46`, `:57` | `DurableExecution`, `DurableAction`, `DurableStateStore`: metadatos sin payload ni IDs de canal. No ofrecen un puerto de confirmaciones conversacionales. |
| `src/agents/durable-gateway.ts:209` | Recuperación completed produce `RESULT_EXPIRED/completed`; los estados inciertos no se reejecutan. No persiste el output financiero completo. |
| `src/channels/telegram/api.ts:13` | `TelegramApi.sendMessage` devuelve `Promise<void>`; no devuelve message_id del prompt. No existe en esta interfaz soporte de callbacks/botones que pueda suponerse ya disponible. |
| `src/channels/telegram/runtime.ts:15`, `src/app/telegram-main.ts:143` | Hooks para comandos/journal y composición de arranque. Se debe probar la misma ruta del handler; no arrancar el main operativo para demostrarla. |
| `tests/telegram-agents.e2e.test.ts:1` | Ya hay tests de polling/handler reales con `TelegramApi` simulado y agente Echo HTTPS. Es el patrón reutilizable para la siguiente prueba, no evidencia de finanzas implementadas. |

Conclusión: **se requiere un mecanismo nuevo de preparación y consentimiento
durable en Jarvis**. Se reutilizan autenticación de canal, bindings, journal de
entrega, Registry, validación, Gateway y transporte. No se reutiliza el journal
de entrega como consentimiento ni se amplía silenciosamente `/agent` a escritura.

En Don Gastón existen `ExpenseService`, SQLite financiero, `DemoAdapter`, journal
del adaptador y capacidades record/lookup 1.0. En
`src/interfaces/jarvis-demo-adapter.ts:91` y `:164` el token está ligado a ámbito,
actor interno y acciones; `:222`/`:247` conservan intención/recuperación.
`tests/interop/confirmation-flow.mjs` prueba estados y CAS, pero su ubicación y
límites son de fixture: no debe importarse como dependencia privada de producción
de Jarvis ni copiarse sin adaptar identidad, entrega, caducidad y persistencia.

## 2. Experiencia propuesta: preparación y confirmación

Todo este apartado es propuesta. No utiliza IA ni amplía capacidades.

### Detección, datos faltantes y categoría

Un parser local acotado reconoce `/gasto` o una gramática española explícitamente
documentada, por ejemplo «Jarvis, gasté $45.000 en gasolina». Su salida es un
borrador estructurado no ejecutable, nunca una llamada automática a record.
Rechaza separadores ambiguos, importes negativos, exceso de longitud y contenido
fuera de gramática. `45.000` en la gramática COP se convierte a texto `45000`,
sin cálculo monetario flotante; el dominio conserva validación financiera final.
Lo no reconocido recibe ayuda o aclaración, no una clasificación probabilística.

La futura interfaz de intérprete podrá proponer ese mismo borrador con datos
faltantes y procedencia. Ni una IA ni el parser pueden establecer identidad,
permisos, `confirmed=true` o ejecutar el Gateway. La incorporación de IA y su
proveedor/datos requiere otra aprobación.

Solo existen `finance.expense.record` y `finance.expense.lookup`: **no existe una
capacidad de listar/buscar/crear categorías**. Para la demo, el fixture crea una
categoría Gasolina en Don Gastón y entrega a configuración de pruebas un mapa
acotado `(instancia,sujeto,"gasolina")→categoryId`. No se consulta SQLite desde
Jarvis, no se inventan IDs y no se aprende un catálogo. Alias desconocido o
ambiguo exige aclaración; el dominio revalida pertenencia/existencia al registrar.
La provisión/sincronización de categorías reales queda fuera del incremento.

- Sin importe: «¿Qué importe en COP quieres registrar?».
- Sin categoría resoluble: «Indica una categoría disponible para esta prueba».
- Sin fecha: **recomendación mínima: pedir fecha civil explícita**. El ejemplo
  abreviado del usuario requiere ese turno adicional. Ofrecer «hoy» exige decisión
  distinta, reloj y zona configurados y mostrar la fecha resuelta; no usar el
  reloj implícito del servidor. Para fixtures, usar `2026-11-17` explícito.
- Campos todavía incompletos permanecen en borrador; no se crea confirmación
  ejecutable ni se llama al agente.

### Prompt y significado de «sí»

Propuesta mínima de prompt:

> ¿Confirmas registrar $45.000 COP en Gasolina, fecha 2026-11-17?
> Referencia G-001. Responde «sí G-001» o «cancelar G-001».

La referencia pública resuelve en almacenamiento local un pending opaco, revisión,
instancia/sujeto, conversación, contenido, huella y caducidad. No es una credencial
y nunca sustituye los permisos actuales. No se envían IDs de Telegram a Don Gastón.

**Recomendación para el mínimo: referencia explícita incluso con una sola pendiente.**
Un «sí» sin referencia devuelve «Confirma la referencia de la operación» y no escribe.
Con varias pendientes debe listar solo referencias/resúmenes del sujeto autorizado,
sin escoger «la última». Así un sí retrasado no confirma por accidente una revisión
nueva o un segundo gasto. Esta desviación deliberada del ejemplo abreviado requiere
aprobación. Para permitir el «sí» exacto del ejemplo con seguridad, una alternativa
posterior es exigir respuesta vinculada al mensaje de confirmación, extendiendo
el parseo de reply metadata y el contrato local de envío/recibos. Esa interfaz no
existe hoy y no se incluye en el mínimo recomendado.

Propuesta adicional: una única confirmación vigente por conversación/sujeto para
reducir ambigüedad; nuevas solicitudes se aclaran o rechazan mientras exista una
ejecución incierta que pudieran estar intentando repetir. No se hace deduplicación
global por importe/categoría: dos gastos iguales pueden ser hechos distintos.

### Cambio, cancelación, envío y resultado

| Acción o situación | Conducta propuesta |
|---|---|
| Cambiar importe/categoría/fecha antes de enviar | CAS sobre revisión pendiente, invalidar la anterior con motivo superseded y crear otra referencia/revisión; mostrar resumen nuevo y exigir nueva confirmación. El sí viejo nunca confirma la nueva. |
| Cancelar antes del envío | CAS awaiting→cancelled; respuesta «Cancelé la solicitud; no envié el gasto». Conservar rastro e intención sin reutilizarlos. |
| Confirmar | Revalidar identidad, conversación, permisos, revisión, huella y vigencia. CAS awaiting→executing y persistir envelope final antes de red. Solo el ganador envía. |
| Otra confirmación, mismo o distinto messageId | Resolver el mismo pending; devolver su estado/evidencia. Nunca derivar un nuevo write id del nuevo mensaje. |
| Cancelar en executing/uncertain/completed | «No puedo cancelar una operación que pudo registrarse. Consultemos su estado». No invocar corrección/anulación: no son capacidades expuestas. |
| Resultado completed válido | «Listo, registré $45.000 COP en Gasolina, fecha 2026-11-17». Renderizar desde salida validada y contexto autorizado; no del texto libre. |
| Fallo definitivo comprobado | Informar rechazo sin afirmar éxito. Otra preparación es explícita, no un reintento automático con nueva clave. |
| Transporte incierto | «No pude confirmar el resultado. Consultaré la intención original; no registraré otro gasto». Lookup solo autorizado, con lectura nueva. |
| Lookup encontrado + incertidumbre | «Encontré el gasto registrado. El flujo sigue pendiente de conciliación con Jarvis; no lo registraré otra vez». |
| Lookup no encontrado o fallido | «Aún no tengo evidencia suficiente. No puedo asegurar que no se haya registrado». Mantener bloqueo de la escritura original. |

La referencia histórica funcional §2 permite gastos claros sin confirmar. Fases
2C/2D aprobaron explícitamente confirmación para esta demostración. Esto no cambia
silenciosamente la política futura de confianza ni autoriza registro automático.

### Caducidad humana distinta del deadline de transporte

La fixture 2C congela un envelope con deadline corto al preparar; eso no sirve
como tiempo de respuesta humano. Propuesta para aprobación: TTL de consentimiento
**5 minutos** desde preparación, con reloj UTC inyectable y caducidad persistida.
No modifica el periodo civil del gasto. Al aceptar, construir el envelope con
deadline de transporte `ahora + 20 s` (dentro del máximo actual de 30 s), guardar
su huella y claves estables en la misma transacción local del cambio a executing.
El consentimiento cubre datos financieros exactos, ámbito, revisión e intención;
no un timestamp de red todavía inexistente. Tras ese punto no se modifican input,
request_id, correlation_id o idempotency_key; tampoco se renueva automáticamente
una escritura incierta. Se cambia orquestación futura, no el wire existente.

Vencimiento sin envío: marcar cancelled con motivo expired o mantener un estado
local expired explícito — para el mínimo se recomienda cancelled+motivo. No
confirmar un borrador vencido después de reiniciar. Una revisión de datos produce
otra confirmación; no se sustituye una intención executing/uncertain.

## 3. Identidad, delegación y autorización

| Identidad | Fuente confiable y uso |
|---|---|
| Humano/canal | Update validado del adaptador autenticado de Telegram; en la demo, updates sintéticos por `TelegramApi` de pruebas. userId/chatId/botId se usan solo dentro de Jarvis. Un update JSON de pruebas no demuestra autenticación humana real. |
| Sujeto lógico | Binding administrado `telegram_user_id→subject_ref` en `parseTelegramAgentsConfig`; no se deriva del texto ni se usa el ID Telegram como subject_ref. |
| Instancia | `instance_id` de composición controlada. Se exige coincidencia en Registry, contexto de ejecución y credencial Don Gastón. |
| Servicio Jarvis | Credencial de request configurada en el Registry y enviada por HTTPS verificado; HMAC de deduplicación y Bearer son secretos separados. |
| Delegado financiero | DemoBinding de Don Gastón fija `actorRef`, `instanceRef`, `subjectRef` y acciones fuera del payload. actorRef identifica al delegado de servicio, **no demuestra qué humano confirmó**. |

Jarvis conservaría evidencia local mínima del humano autorizado mediante referencia
opaca/HMAC al contexto de canal, pending, revisión y acción de confirmación. No
añadir userId, actorRef, permisos o datos de canal al input record/lookup.
Don Gastón conserva actor delegado e intención como hasta ahora. Correlacionar
auditorías bajo permisos; no exponer secretos ni el texto íntegro en logs.

Revalidar al preparar, confirmar, cancelar, consultar estado y revelar evidencia:
allowlist/binding actual, mismo bot/chat/sujeto, capacidad autorizada y permiso
local de operación. Don Gastón vuelve a validar `expense:record`/`expense:read`.
Una revocación posterior a la preparación impide ejecutar o presentar evidencia.
Necesarios únicamente `finance.expense.record` y `finance.expense.lookup` 1.0;
ningún permiso de categorías, correcciones, pagos ni comodín.

Límite de composición: el Registry actual elige credencial por agente registrado,
no por sujeto arbitrario del payload; DemoBinding ata un token a un sujeto.
El primer recorrido usará un sujeto sintético autorizado y otro para denegación,
sin resolver mediante un Bearer global multiusuario. Multiusuario real exigiría
decidir selección de credencial/registro delegado por sujeto y revisar su diseño,
sin conceder scopes amplios para que pase una prueba.

## 4. Propiedad del estado y persistencia

| Base de demostración | Responsable y futuro uso propuesto | Qué no debe guardar |
|---|---|---|
| `finance.sqlite` | Don Gastón: hecho financiero, huella/intención, resultado original, proyecciones; única autoridad monetaria. Reutilizar sin migraciones nuevas. | Estado de chat, prompts, consentimiento humano o entrega Telegram. |
| `adapter.sqlite` | Frontera Don Gastón: reserva y huella wire, claves traducidas; conservar junto al ledger para recuperar. | Credenciales, conversaciones, una segunda contabilidad. |
| `jarvis.sqlite` | Jarvis: journal de ejecución, HMAC/contexto/outcome, acciones/entrega y offsets. Reutilizar sus puertos y validación de instalación. | Payload financiero completo, output como ledger, nuevos significados de result-confirmed. |
| `flow.sqlite` | En 2C pertenece a la fixture. En la propuesta, estado conversacional sería responsabilidad de Jarvis mediante un puerto nuevo y un store de pruebas separado. | Datos financieros ajenos a la solicitud/evidencia necesaria, tokens o texto íntegro del chat. |

Para la demo posterior se recomienda conservar **cuatro archivos**; no elegir
ahora una migración al journal productivo ni incorporar payloads al puerto
`DurableStateStore`, que explícitamente los excluye. Nuevo store de conversación
con creación explícita, reapertura obligatoria, binding de instalación, versión,
validación, límites y CAS; sus operaciones usan transacciones locales propias.
No modificar SQL directamente en journals existentes.

Estado mínimo de conversación propuesto: pendingId opaco, contexto autorizado
HMAC, revisión y huella, datos exactos mostrados, categoryId/etiqueta fixture,
moneda/fecha, intención wire estable, creado/caduca, confirmación/motivo de cierre,
estado del flujo, último outcome recibido y referencia/fecha de evidencia lookup.
Conservar eventos de revisión/consentimiento sin sobrescribir historia. Reutilizar
plantillas en vez de guardar todo el chat. El importe del borrador es una copia
necesaria para consentimiento, no un saldo/total financiero paralelo. El estado
de entrega sigue siendo independiente del estado de gasto.

El CAS de confirmación debe fijar el único envelope definitivo antes de invocar
el Gateway. Entrega de prompt/resultado se registra por separado. Si sendMessage
falla o su entrega es incierta, no asumir que el humano vio el prompt ni volver
a registrar el gasto. Una consulta explícita de pendientes puede volver a mostrar
la **misma** referencia/revisión con una acción nueva de lectura/presentación.
No resucitar automáticamente acciones de canal bloqueadas ni deduplicar únicamente
en las colecciones en memoria del handler.

## 5. Reinicio, recuperación y respaldo

| Punto de interrupción | Recuperación segura propuesta |
|---|---|
| Antes de persistir preparación | No existe confirmación válida ni efecto; nuevo mensaje puede preparar de forma deduplicada. |
| Preparado, antes/después del envío de prompt | Reabrir mismo pending; no ejecutar por arrancar. Solo confirmar referencia vigente, sujeto y revisión exactos; reshow explícito si entrega no acreditada. |
| CAS executing, antes del envío | Tratar conservadoramente como incierto al reconstruir; lookup puede no encontrar nada, pero eso no permite inventar otra escritura. |
| Commit financiero, respuesta perdida | Ledger y reserva pueden existir aunque Jarvis quede uncertain. Lookup por intención original; evidencia aparte, journal intacto. |
| Respuesta completed perdida para el flujo | El Gateway puede conservar completed sin output; RESULT_EXPIRED/completed conduce a lookup, nunca a otra escritura. |
| Respuesta guardada, mensaje final perdido | Gasto sigue registrado; recuperar/presentar mismo resultado, no repetir record. Entrega incierta no equivale a fallo financiero. |
| Recuperación concurrente con ejecución | CAS puede conservar incertidumbre aunque el gasto ya exista. Comunicar estado del flujo sin atribuir una lectura actual no realizada del journal. |

Tres dimensiones siempre distintas: evidencia financiera, outcome del Gateway,
estado de conversación/entrega. No convertir found:true en un SQL update del
journal uncertain. No convertir found:false en failed/no commit. No prometer
exactamente una vez. Reintentos/lecturas concurrentes deben conservar intención
original; nuevas claves solo para lecturas independientes y acciones de canal.

Antes de datos reales: respaldo consistente de ambos repositorios y su configuración
de bindings/IDs/huellas, con claves protegidas por separado. Propuesta futura:
quiescencia controlada de nuevas escrituras, resolución/documentación de operaciones
en vuelo, snapshots mediante APIs SQLite por propietario, manifiesto común con
versiones/checksums/instancia/generación y pendientes, y restauración en entorno
aislado con efectos externos bloqueados hasta revisión. Medir RPO/RTO y probar
pares faltantes, bases de distinta generación, claves perdidas y estados inciertos.
Copiar cuatro archivos en instantes diferentes no constituye backup coordinado.
No se implementa este protocolo ni conciliación automática en el próximo mínimo.

## 6. Archivos y cambios propuestos, sujetos a aprobación

Las rutas marcadas **nuevas** son nombres propuestos, no interfaces existentes.

| Repositorio/ruta | Cambio mínimo posterior |
|---|---|
| Jarvis `src/channels/telegram/handler.ts` | Ruta optativa de conversación autorizada después de validación del remitente; incluir preparación/confirmación/consulta en reserva durable. Conservar start/status, denegaciones y límites. |
| Jarvis `src/channels/telegram/runtime.ts` | Puerto/hook de conversación separado y explícito; activar solo en composición de pruebas inicialmente. |
| Jarvis **nuevo** `src/channels/telegram/expense-conversation.ts` | Gramática acotada, aclaración y referencias; obtener identidad desde mensaje ya autenticado, nunca del texto. No dinero de dominio aquí. |
| Jarvis **nuevo** `src/app/expense-confirmation.ts` | Orquestar borrador, consentimiento, estados, CAS, record/lookup y plantillas; depender de AgentExecutionService y puerto de estado. |
| Jarvis **nuevo** `src/app/confirmation-store.ts` y `src/infrastructure/sqlite-confirmation-store.ts` | Puerto/versionado para estado de conversación independiente; no añadir tablas financieras ni reinterpretar DurableAction. |
| Jarvis `src/app/telegram-agents.ts` | Composición optativa de schemas record/lookup, acceso al servicio de ejecución y store durable obligatorio para este perfil. Sin activar loader/main operativo. |
| Jarvis **nuevo** `src/agents/finance-expense-profile.ts` | Validadores locales de los schemas ya aprobados, probados contra fixtures de conformidad. Sin imports privados de Don Gastón, sin nueva capacidad, sin descarga dinámica de schemas. |
| Jarvis `src/channels/telegram/durable-actions.ts` | Reutilizar puerto de entrega/reserva; modificar solo si hace falta distinguir acciones nuevas sin alterar semántica histórica. Probar que todas las entradas nuevas pasan por él. |
| Jarvis `src/channels/telegram/agent-commands.ts`, `src/app/agent-read.ts` | Mantener `/agent` y supported read-only. No es el lugar para quitar restricciones de Echo y permitir write genérico. |
| Jarvis `tests/telegram-agents.e2e.test.ts`, `tests/durable-telegram.test.ts`, **nuevo** `tests/expense-conversation.test.ts` | Regresión de routing/entrega y aceptación de nueva conversación con API Telegram simulada y Gateway real. |
| Don Gastón `tests/interop/jarvis-real-harness.mjs`, **nuevo** `tests/interop/jarvis-conversation.test.mjs` | Reutilizar receptor efímero/TLS/fixture Gasolina; cargar composición conversacional real de Jarvis aprobada y probar recorrido completo. No más controlador alternativo. |
| Ambos, docs de flujo/contrato local de composición | Documentar interfaces nuevas de consentimiento, configuración sintética y reproducción. El contrato wire financiero no cambia. |

No se requiere modificar dominio, migraciones financieras, capacidades ni el
Gateway durable. No modificar `telegram-main.ts`, archivos privados o políticas
de red productivas para activar este primer recorrido. Cualquier activación futura
del loader operativo es otro alcance. La regla actual de Jarvis que prohíbe
escrituras en el flujo de lectura debe conservarse; la aprobación futura debe
autorizar explícitamente la nueva ruta separada de pruebas y su documentación.

## 7. Pruebas de aceptación del siguiente incremento — diseñadas, no ejecutadas

Usar Node 24.22.3, dependencias existentes, API Telegram simulada ya prevista por
el puerto, handler/polling/composición reales, Gateway durable/Registry/HTTPS
reales y Don Gastón sintético. No basta llamar directamente al controlador 2C.

| Caso | Aserción indispensable |
|---|---|
| Mensaje ficticio completo | Handler auténtico produce prompt exacto; cero gastos antes de confirmar; fecha/moneda visibles. |
| Faltantes/ambigüedad | Pedir importe/fecha/categoría; ninguna llamada record; alias y formato ambiguos no se adivinan. |
| Confirmación con referencia | Una intención durable y un gasto minor 4500000; respuesta de plantilla desde output validado. |
| Sí aislado/varias pendientes | No ejecutar por heurística; solicitar referencia sin revelar operaciones ajenas. |
| Cambio previo | Nueva revisión/ref, confirmación vieja denegada; solo datos nuevos confirmados llegan al dominio. |
| Cancelar/confirmar concurrentes | Un único ganador del CAS; si ya pudo enviarse, no prometer cancelación financiera. |
| Duplicados de update y de «sí» con otro messageId | Mismo pending y write key; un gasto y ninguna segunda ejecución financiera. |
| Identidad | Allowlist, grupo, bot, sender_chat, usuario/chat ajenos, bot incorrecto y campos de identidad inyectados rechazados antes de preparación/ejecución. |
| Revocación | Retirar binding/permiso tras preparar impide confirmar y consultar evidencia. |
| Prompt perdido/429/envío incierto | Estado/entrega separados; reconsulta muestra misma referencia; no confirmar automáticamente ni reservar otra escritura. |
| Reinicio pendiente | Reabre revisión/caducidad, no escribe hasta consentimiento válido; vencida no se reactiva. |
| Caída tras executing/commit | Recuperar por lookup; uncertain del Gateway intacto; no nuevas claves write; found:false no acredita fallo. |
| RESULT_EXPIRED/completed | Recuperar resultado original; no segundo record. |
| Mensaje final perdido | Consulta devuelve mismo hecho; fallo de entrega no cambia completed a fallo financiero. |
| TLS, límites y plazos | CA/hostname erróneos, input/output inválidos y timeout se clasifican sin inventar ausencia de commit. TTL humano y deadline de red se prueban por separado. |
| Regresión del canal | start/status, Echo read-only, offset durable, reservas y límites anteriores conservados; nueva ruta no evade journal. |
| Conformidad | Schemas locales nuevos de Jarvis aceptan/rechazan las mismas fixtures que el perfil Don Gastón; solo dos capacidades. |

## 8. Riesgos y bloqueantes

1. No hay aprobación para editar Jarvis todavía. El diseño no habilita cambios.
2. Falta persistencia/confirmación humana real: el journal de entrega no la resuelve.
3. Parser, categorías y fechas limitados: sin catálogo remoto y sin reglas de fecha
   por defecto, el ejemplo necesita aclaración. No ocultar esa diferencia.
4. Referencias/caducidad/entrega deben quedar vinculadas durablemente; texto «sí»
   por sí solo y messageId nuevo no constituyen consentimiento inequívoco.
5. Estado conversacional guarda contenido sensible mínimo, a diferencia del journal
   actual sin payloads. Requiere política de acceso, retención y respaldo antes de
   uso real; hash de contenido no protege contra escritura local maliciosa.
6. Schemas duplicados entre repos independientes pueden divergir: fixtures de
   conformidad y versiones, no imports privados de producción ni descarga dinámica.
7. Recuperación puede conservar incertidumbre aunque haya gasto. No hay desbloqueo
   ni conciliación operativa aprobados; la UI debe poder explicar esa diferencia.

Controles imprescindibles para la demo: autenticación de fixture desde handler,
actor externo, permisos mínimos revalidados, confirmación durable/CAS, claves
estables, tres journals/ledger intactos, TLS verificado, límites, cleanup y pruebas
negativas. Antes de uso real además: gestión de claves/revocación, recuperación
coordinada, políticas de datos/retención, observabilidad sin información sensible,
responsable de incidentes y autorización independiente de despliegue/datos/canales.

## 9. Plan mínimo posterior

1. Aprobar las decisiones de la sección 10 y autorizar rutas acotadas en Jarvis.
2. Implementar puerto de consentimiento y pruebas unitarias deterministas de
   revisión/TTL/CAS, con archivo de estado sintético separado.
3. Componer perfil financiero optativo con schemas existentes y servicio real;
   conservar `/agent` read-only y el loader operativo deshabilitado para finanzas.
4. Incorporar routing real del handler y gramática explícita con referencia;
   reusar API de pruebas y journal de entrega, sin crear otro simulador de core.
5. Ejecutar el recorrido completo sintético y fallos de la matriz, regresión de
   canal/composición afectada y verificaciones de ambos repos con Node compatible.
6. Entregar evidencias y diff acotado para revisión. Detener antes de activar
   Telegram operativo, conciliación automática, FIN-01 o información real.

## 10. Decisiones que requieren aprobación

| Decisión | Recomendación concreta para aprobar el siguiente incremento |
|---|---|
| Edición de Jarvis | Autorizar nueva ruta conversacional optativa y archivos enumerados; sin activar configuración operativa ni convertir `/agent` en write genérico. |
| Interacción | Gramática determinista acotada y referencia obligatoria «sí G-001»; sí aislado pide referencia. Un pending vigente por conversación/sujeto. |
| Fecha | Pedir fecha civil si falta; no default «hoy» en el mínimo. |
| Categoría | Mapa sintético Gasolina→ID configurado por fixture y por ámbito; sin nueva capacidad ni catálogo productivo. |
| Vigencia | Consentimiento 5 minutos; construir/persistir envelope definitivo al confirmar con deadline 20 segundos. No renovar escrituras inciertas. |
| Persistencia | Store conversacional nuevo propiedad de Jarvis, separado del journal existente en la demo; revisión/consentimiento auditables, sin elegir almacenamiento productivo definitivo. |
| Alcance del ensayo | Handler/polling reales + TelegramApi simulado existente + HTTPS Don Gastón; un sujeto autorizado y otro denegado, sin Telegram real. |

No se solicita cambiar record/lookup 1.0 ni añadir actor humano al wire. Si la
implementación descubre necesidad de modificar esos contratos, deberá detener
esa parte y presentar la diferencia para nueva aprobación.

## Revisión y verificaciones de esta fase

Coordinador: inspección de código Jarvis autorizada en lectura y único autor de
este informe. Especialistas asignados solo a inspección/diseño: `finance_domain`
para semántica/fechas/categorías y trazabilidad, `security_reviewer` para identidad
y propiedad del estado local, `test_engineer` para aceptación y fallos de canal.
Sin propiedad compartida de escritura, tests nuevos ni ejecución de suites.

Se verificaron rutas y referencias contra fuentes locales: 14 referencias con
archivo/línea y 3 enlaces locales válidos; `git diff --check` sin errores y diff
de fuentes Jarvis inspeccionadas frente a HEAD vacío. El primer validador de
referencias confundió una ruta Don Gastón con Jarvis; se corrigió la selección
de repositorio y pasó. No se ejecutaron suites, lint o build, porque solo se
añadió este documento. No se consultaron `.env`, tokens,
bases operativas, logs ni conversaciones; no se crearon bases ni procesos de
aplicación. Las evidencias históricas se conservan en
[Fase 2A](JARVIS_REAL_GATEWAY_INTEROP.md),
[Fase 2B](JARVIS_NODE_COMPATIBILITY.md) y
[Fase 2C](JARVIS_CONFIRMATION_FLOW.md).

Fase 1 permanece abierta; este diseño no autoriza uso financiero real ni declara
preparación para producción.
