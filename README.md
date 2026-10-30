# Postula

**Encontrá mejores oportunidades. Prepará cada candidatura con tu experiencia real.**

Postula es una pequeña app web en español para reunir ofertas públicas, comparar requisitos, preparar un CV por puesto y seguir tus postulaciones.

## Probarla

- **En Windows:** abrí `INICIAR.bat` o `index.html`.
- **En Vercel o Netlify:** importá este repositorio como sitio estático. No requiere instalar dependencias ni compilar.

## Primeros pasos

1. En **Mi perfil**, cargá contacto, objetivos, experiencia y habilidades.
2. En **Fuentes para búsqueda en vivo**, agregá nombres públicos de boards Greenhouse o sites Lever.
3. Tocá **Buscar ofertas** y revisá encaje, requisitos y fuente.
4. Abrí una oferta, revisá y autorizá la candidatura. Postula descarga el CV adaptado y abre la página de empleo para continuar allí.

También se puede explorar la interfaz con ejemplos marcados **DEMO**. No son vacantes vigentes.

## Qué puede hacer

- Consultar feeds públicos de Greenhouse y Lever.
- Filtrar y guardar ofertas.
- Comparar términos del perfil con los requisitos y mostrar una coincidencia orientativa.
- Reorganizar la información aportada para generar una vista previa y descargar un CV en texto por oferta.
- Abrir el portal de empleo de la empresa y registrar el estado de seguimiento.

## Qué no hace

Esta versión no inicia sesión ni completa o envía formularios de terceros. Los portales usan preguntas, controles y reglas distintas; las credenciales se introducen directamente en el sitio de la empresa. LinkedIn e Indeed restringen bots de terceros. No se eluden CAPTCHAs ni controles de acceso.

El porcentaje de encaje es orientativo, basado en coincidencias de texto. Revisá el CV, las respuestas y la publicación antes de postularte.

## Privacidad

Perfil, preferencias y seguimiento se guardan en `localStorage` del navegador. No hay servidor propio, analítica ni sincronización entre dispositivos. Cuando consultás fuentes en vivo, el navegador solicita los datos públicos a Greenhouse o Lever. En una computadora compartida, borrá los datos desde **Mi perfil → Borrar mis datos**.

Al publicar el sitio, el código será público. La app no debería contener datos de perfil reales ni credenciales.

## Publicar en Vercel o Netlify

El código ya está en GitHub. En cualquiera de los proveedores:

1. Elegí **Add New Project / Add a site → Import from GitHub** y autorizá el repositorio `Ignacio918/Postula`.
2. Configurá el proyecto como estático, con directorio raíz `.`; dejá vacíos el comando de build y el directorio de salida.
3. Publicá y abrí la URL temporal que te da el proveedor.

El sitio usa solo HTML, CSS y JavaScript y tiene `index.html` en la raíz. No necesita un backend. Para que la búsqueda en vivo funcione, abrilo desde el dominio de Vercel/Netlify o desde un servidor local, no desde `file://`.

## Ejecutar un servidor local opcional

Desde esta carpeta, ejecutá:

```powershell
python -m http.server 8000
```

Después abrí <http://localhost:8000>. El servidor local evita restricciones que algunos navegadores aplican a llamadas de red desde `file://`.

## Tecnología

HTML, CSS y JavaScript nativos. Sin dependencias de compilación.

## Licencia

MIT. Ver [LICENSE](LICENSE).
