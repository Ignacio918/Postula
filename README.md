# Postula

Postula busca vacantes, las compara con tu CV, prepara una versión orientada al puesto y permite que un agente local complete y envíe solicitudes compatibles.

## Puesta en marcha

1. Iniciá sesión en [Postula](https://postula-iota.vercel.app/) y abrí **Mi perfil**.
2. Importá tu CV en PDF o TXT. La extracción del PDF se hace en el navegador; revisá los datos de contacto y guardá el perfil.
3. Completá los puestos que buscás. La búsqueda incluye Remotive y Jobicy; Greenhouse y Lever son fuentes adicionales opcionales.
4. Definí modalidad, encaje mínimo y máximo diario. Guardá los cambios.
5. Elegí **Descargar configuración del agente**. El JSON incluye CV y datos personales: queda en tu computadora, no lo subas al repo ni lo compartas.
6. Instalá el agente local siguiendo la sección siguiente.

La app consulta Remotive, Jobicy y Remote OK al tocar **Buscar ofertas**. El agente local suma Himalayas, los feeds de diseño, producto y gestión de We Work Remotely, Arbeitnow y boards Greenhouse/Lever opcionales. También puede ampliar la búsqueda a la web con Brave Search: cada seis horas hace dos consultas usando tus puestos objetivo, detecta boards públicos de Ashby, Greenhouse y Lever, y revisa páginas de empresas que publican datos estructurados `JobPosting`. Los resultados genéricos del buscador no se guardan como vacantes: se aceptan avisos extraídos del ATS público o de la página oficial del empleo.

Para activar la búsqueda web amplia, creá una cuenta en [Brave Search API](https://api-dashboard.search.brave.com/) y generá una clave. Creá el archivo `.postula-agent\brave-search-api-key.txt` dentro del repo y pegá únicamente la clave en una línea. También podés definir la variable local `POSTULA_BRAVE_SEARCH_API_KEY`. Nunca pegues la clave en el chat, en el JSON del perfil ni en GitHub. El directorio `.postula-agent` está excluido de Git. La API de búsqueda no usa modelos generativos ni tokens de OpenAI; Brave publica un precio de USD 5 por 1.000 consultas y créditos promocionales mensuales sujetos al plan/cuenta ([precios oficiales](https://api-dashboard.search.brave.com/documentation/pricing)). Dos consultas cada seis horas equivalen a unas 240 consultas mensuales si Postula permanece activo todo el mes; revisá el panel de Brave para confirmar el crédito y el consumo de tu cuenta.

No se automatiza Google Search: Google considera que las consultas automatizadas sin permiso son acceso abusivo, y su Custom Search JSON API ya no admite nuevos clientes ([política de Google](https://developers.google.com/search/docs/essentials/spam-policies), [estado de Custom Search API](https://developers.google.com/custom-search/v1/overview)). Google Jobs puede mostrar avisos como persona desde el navegador, pero esta integración descubre vacantes por API pública de búsqueda y visita las páginas de empresas/ATS. Puede encontrar más avisos que los feeds iniciales, aunque ninguna fuente indexa literalmente toda la web. Remotive se consulta como máximo cada seis horas; Jobicy ofrece puestos publicados en los últimos siete días. Las tarjetas **DEMO** son ejemplos, nunca vacantes actuales. El encaje usa coincidencias de términos y puestos objetivo; es una señal orientativa, no una evaluación de contratación.

## Instalar y ejecutar el agente local

Requisitos: Node.js 20 o superior y una terminal en la carpeta del repo.

```powershell
npm install
npx playwright install chromium
npm run agent -- "C:\Users\TU_USUARIO\Downloads\postula-agent-config.json"
```

En Windows, guardá el JSON descargado como `.postula-agent\postula-agent-config.json` dentro del repo y abrí `INICIAR_AGENT.bat`. Se abre la app nativa **Postula · Agente de escritorio**. Muestra la búsqueda, las ofertas compatibles, los formularios listos, actividad y envíos confirmados. La ventana permite detener el agente y confirmar cada envío; **Abrir aviso** abre en el navegador una oferta puntual para revisión manual. Chromium funciona oculto; el panel de control no es una página web y escucha únicamente en `127.0.0.1` para comunicarse con el proceso local. El wordmark y el símbolo vectorial están en `assets/`; `npm run brand:render` regenera el ícono PNG/ICO desde el SVG. Ejecutá `agent\CreateDesktopShortcut.ps1` para crear o actualizar el acceso directo del escritorio.

El agente usa Chromium en segundo plano y consulta las fuentes cada 30 minutos mientras la ventana de escritorio siga abierta. En el primer uso, el navegador crea `.postula-agent/browser-profile`; iniciá sesión allí directamente en los portales donde tengas cuenta. Las contraseñas no se guardan en Postula ni en el JSON; las cookies quedan en ese perfil local del navegador. Si una oferta requiere revisión, **Abrir aviso** la abre en el navegador solo cuando lo pedís.

El agente busca en sus feeds cada 30 minutos; la consulta web se limita a una vez cada seis horas, y el máximo diario solo limita los envíos. Remotive se cachea seis horas e Himalayas un día; otras fuentes se cachean una hora. Registra las ofertas procesadas en `.postula-agent/results.json` y no vuelve a procesar las excluidas o enviadas aunque aparezcan desde otra fuente. Genera un PDF orientado al puesto y completa campos estándar con datos de tu perfil. El puntaje y la adaptación del CV usan reglas locales: no llaman a OpenAI ni consumen tokens de modelo. Cuando un formulario está completo, el panel muestra la empresa y el puesto: **Confirmar y enviar** autoriza ese envío puntual. Si aparece un CAPTCHA o falta una respuesta, el aviso queda marcado para revisión; usá **Abrir aviso** si querés resolverlo manualmente. El agente no intenta resolver ni esquivar verificaciones. Guarda también los PDFs en `.postula-agent/resumes/`. Para sincronizar estados, abrí **Mi perfil → Importar resultados** y elegí `.postula-agent/results.json`.

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
