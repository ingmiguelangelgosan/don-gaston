# Modelo de seguridad y privacidad — Don Gastón

## Estado

Normas de diseño y puertas de aprobación. **No son verificaciones de una aplicación implementada**. El informe consolidado de Jarvis cierra recopilación y registra riesgos residuales; NO confiere autorización a Don Gastón para operar con dinero real o conectarse a Lightsail.

## Activos protegidos

Identidad de los sujetos, transacciones y saldos, recibos, tasas y detalles personales, claves de IA, credenciales Jarvis↔Don Gastón, respaldos y claves de cifrado.

## Riesgos y controles necesarios

| Riesgo | Control mínimo |
|---|---|
| Solicitud financiera falsificada | Autenticación mutua o credenciales por servicio, vínculo sujeto/instancia fuera de payload editable, autorización por capacidad |
| Duplicación por reintento/timeout | `intent_id` estable, huella, unicidad, transacción, estado consultable y casos concurrentes |
| Acceso entre sujetos | Separación de instancias inicial; filtros y pruebas negativas si multiusuario posterior |
| Doble contabilización | Ledger con identidad estable y derivaciones de caja/consumo; pruebas |
| Secretos en logs/PR | .gitignore, escaneo/revisión, error sanitizado, nunca incluir valores reales |
| Recibos expuestos | Buckets privados, rutas controladas, URLs temporales, límites de tamaño/tipo |
| Respaldo inutilizable | Copia protegida, restauración en entorno aislado, prueba RPO/RTO y llave de descifrado |
| Proveedores IA incompatibles | No transmitir hasta validación de términos de privacidad, retención, presupuesto y permiso |
| Escalada al host Jarvis | Sin Docker socket, SSH, volúmenes privilegiados, rutas del bot ni capacidades Linux especiales |

## Prohibiciones para Fase 0

- Nada de AWS, Lightsail, DigitalOcean, Supabase remoto, Telegram real o claves privadas.
- Nada de pagos reales, banca, escrituras de gastos con datos personales, descarga de recibos reales o modificación de servidores.
- Ningún agente puede modificar Jarvis de forma automática.

## Puerta para producción futura

Evidenciar tests de contrato y recuperación, revisión de permisos y secretos, respaldo/restauración funcional, identidad y autorizaciones, procedencia del build, política de retención, revisión de código y aprobación humana. Un `PASS` aislado no certifica el sistema entero.
