# Postula

Postula busca vacantes, las compara con tu CV, prepara una versión orientada al puesto y permite que un agente local complete y envíe solicitudes compatibles.

## Puesta en marcha

1. Iniciá sesión en [Postula](https://postula-iota.vercel.app/) y abrí **Mi perfil**.
2. Importá tu CV en PDF o TXT. La extracción del PDF se hace en el navegador; revisá los datos de contacto y guardá el perfil.
3. Completá los puestos que buscás. La búsqueda incluye Remotive y Jobicy; Greenhouse y Lever son fuentes adicionales opcionales.
4. Definí modalidad, encaje mínimo y máximo diario. Guardá los cambios.
5. Elegí **Descargar configuración del agente**. El JSON incluye CV y datos personales: queda en tu computadora, no lo subas al repo ni lo compartas.
6. Instalá el agente local siguiendo la sección siguiente.

La app consulta Remotive, Jobicy y Remote OK al tocar **Buscar ofertas**. El agente local suma Himalayas, los feeds de diseño, producto y gestión de We Work Remotely, Arbeitnow, y boards Greenhouse y Lever opcionales. Conserva enlaces de postulación publicados dentro de las descripciones y prioriza el portal externo del empleador/ATS. Sigue siendo posible que un agregador no exponga ese enlace o que el portal requiera pasos manuales. Google Jobs sirve para buscar puestos desde la interfaz de Google, pero el agente no extrae resultados automáticamente desde Google Search; Google restringe el acceso automatizado sin permiso expreso ([política oficial](https://developers.google.com/search/docs/essentials/spam-policies)). Remotive se consulta como máximo cada seis horas; sus ofertas conservan la atribución y el enlace original. Jobicy ofrece puestos publicados en los últimos siete días. Las tarjetas **DEMO** son ejemplos, nunca vacantes actuales. El encaje usa coincidencias de términos y puestos objetivo; es una señal orientativa, no una evaluación de contratación.

## Instalar y ejecutar el agente local

Requisitos: Node.js 20 o superior y una terminal en la carpeta del repo.

```powershell
npm install
npx playwright install chromium
npm run agent -- "C:\Users\TU_USUARIO\Downloads\postula-agent-config.json"
```

En Windows, guardá el JSON descargado como `.postula-agent\postula-agent-config.json` dentro del repo y abrí `INICIAR_AGENT.bat`. Se abre la app nativa **Postula · Agente de escritorio**. Muestra la búsqueda, las ofertas compatibles, los formularios listos, actividad y envíos confirmados. La ventana permite detener el agente, enfocar un formulario y confirmar cada envío. Chromium aparece solo para los portales de empleo; el panel de control no es una página web y escucha únicamente en `127.0.0.1` para comunicarse con el proceso local. El ícono de Postula está en `assets/`; también podés usar el acceso directo del escritorio, que apunta a tu copia local.

El agente abre Chromium visible y consulta las fuentes cada 30 minutos mientras la ventana de escritorio siga abierta. En el primer uso, el navegador crea `.postula-agent/browser-profile`; iniciá sesión allí directamente en los portales donde tengas cuenta. Las contraseñas no se guardan en Postula ni en el JSON; las cookies quedan en ese perfil local del navegador.

El agente busca cada 30 minutos; el máximo diario solo limita los envíos, no las búsquedas. Remotive se cachea seis horas e Himalayas un día; otras fuentes se cachean una hora. Registra las ofertas detectadas para no volver a procesarlas y guarda URL, estado y motivo en `.postula-agent/results.json`. Genera un PDF orientado al puesto y completa campos estándar con datos de tu perfil. La búsqueda, el puntaje y la adaptación del CV usan reglas locales: no llaman a OpenAI ni consumen tokens de API. Cuando un formulario está completo, el panel muestra la empresa y el puesto: **Confirmar y enviar** autoriza ese envío puntual. Si aparece un CAPTCHA, deja la pestaña visible y espera hasta 10 minutos a que lo resuelvas vos; no intenta resolverlo ni esquivarlo. Si falta una respuesta, conserva el portal abierto y sigue con la búsqueda. Guarda también los PDFs en `.postula-agent/resumes/`. Para sincronizar estados, abrí **Mi perfil → Importar resultados** y elegí `.postula-agent/results.json`.

## Límites del agente

- Las fuentes públicas no representan literalmente toda la web. Portales privados o sin API pública pueden no aparecer. Los avisos conservan su fuente y enlace de aplicación original; algunas bolsas solo llevan a la página del empleo y no exponen un formulario compatible.
- La adaptación actual destaca el puesto y las competencias encontradas en tu CV, y prioriza bloques de experiencia. Conserva el texto de origen; no inventa datos ni hace una reescritura generativa con IA.
- Antes de cada envío, confirmalo con **Confirmar y enviar** en el panel local, junto al nombre de la empresa y el puesto. El agente se limita a los avisos que pasan el encaje mínimo y al tope de 20 envíos diarios.
- Si un formulario pide un dato ausente, una declaración legal, un CAPTCHA, una verificación o un paso que el agente no reconoce, lo deja pendiente con el enlace y motivo en `results.json`; no vuelve a procesarlo en cada ciclo ni adivina respuestas o evade controles.
- Los formularios cambian por empresa. Revisá el resultado local, especialmente los estados `submitted_unconfirmed` y `needs_attention`.
- El agente funciona en tu computadora, no como tarea de fondo de Vercel. Dejá abierta la app de escritorio y el navegador para que siga buscando cada 30 minutos. Necesita que tu sesión esté iniciada y la PC encendida.

## Desarrollo y despliegue web

El sitio es HTML, CSS y JavaScript estáticos. Vercel publica `main`; el build genera `dist/` e incluye el worker de PDF.js.

```powershell
npm install
$env:POSTULA_AUTH_URL="<Neon Auth URL>"
$env:POSTULA_DATA_API_URL="<Neon Data API URL>"
npm run build
```

En Vercel, configurá el comando `npm run build`, el directorio de salida `dist` y las variables `POSTULA_AUTH_URL` y `POSTULA_DATA_API_URL` para Production. No agregues secretos al repositorio.

La cuenta Postula y sus datos están en Neon. El agente usa una copia local del perfil descargada por la persona usuaria; no recibe la contraseña de Neon ni las claves de portales.

## Licencia

MIT. Ver [LICENSE](LICENSE).
