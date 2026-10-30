# Postula

App web en español para organizar una búsqueda de empleo, comparar ofertas y preparar CVs adaptados al puesto. El modo local funciona sin cuenta; la sincronización entre dispositivos requiere configurar Neon.

## Iniciar

En Windows, abrí `INICIAR.bat` o hacé doble clic en `index.html`. Para habilitar las búsquedas en vivo desde todos los navegadores, podés iniciar el servidor local con `python -m http.server 8000` y abrir `http://localhost:8000`.

Para publicarla, conectá el repositorio con Vercel. La configuración de Neon está en el [README](README.md).

## Primer uso

1. Entrá en **Mi perfil** y cargá tus datos, resumen, experiencia y habilidades.
2. Para ofertas en vivo, agregá identificadores de boards públicos Greenhouse o sites públicos Lever en la sección **Fuentes para búsqueda en vivo**.
3. Volvé a **Ofertas** y seleccioná **Buscar ofertas**.
4. Abrí una oportunidad, revisá encaje y requisitos, y usá **Preparar postulación** para descargar el CV adaptado y abrir el formulario de la empresa.
5. Iniciá sesión en el sitio oficial y completá allí cualquier dato específico. La app lleva el registro como **En el sitio de la empresa**; actualizalo luego según el resultado.

En modo local, los datos de perfil, ofertas guardadas y candidaturas quedan en el navegador. Si configurás Neon, la cuenta y los datos se guardan en Neon con políticas por usuario. Consultá el [README](README.md) antes de cargar información personal.

## Alcance de esta versión

- Incluye seis ofertas demostrativas para explorar el diseño. Están etiquetadas `DEMO`; no representan puestos actuales ni deben usarse para enviar una candidatura.
- La búsqueda en vivo consulta los endpoints públicos de lectura de Greenhouse y Lever para las empresas que configures.
- El botón de candidatura descarga el CV adaptado y abre el formulario oficial de la vacante. Por seguridad, iniciá sesión en el sitio de la empresa; esta app no almacena contraseñas.
- Esta versión no completa ni envía formularios de terceros en automático. El cierre de sesión, CAPTCHA, preguntas sensibles y restricciones del sitio deben resolverse en el sitio oficial.
- Las ofertas nuevas reciben una coincidencia inicial orientativa. Su comparación completa mejora cuando el perfil incluye experiencia y habilidades relevantes.
- La vista previa de CV reorganiza texto provisto por la persona. No genera PDF ni añade hechos nuevos.

Para enviar postulaciones por API se necesitan credenciales y permisos de la organización propietaria del ATS. LinkedIn e Indeed restringen automatizaciones de terceros en sus servicios. Revisá las condiciones de cada fuente antes de automatizar el envío.
