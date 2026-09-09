# Despliegue — SensoLab

## Opción A — Docker en tu laptop (lo que estás haciendo ahora)

Un solo contenedor sirve **app + sitio + backend + asistente**.

```bash
cp .env.example .env          # pon tu OPENAI_API_KEY
docker compose up -d --build
```

- App:   http://localhost:4000
- Sitio: http://localhost:4000/site/
- Datos: volumen `sensolab-db` (persiste; `docker compose down -v` lo borra).
- `restart: unless-stopped` → sobrevive reinicios de la laptop.
- Para que sea accesible desde fuera: túnel (`cloudflared tunnel --url http://localhost:4000`)
  o port-forward del puerto 4000 en tu router. Luego, si el sitio se sirve desde
  otro dominio, actualiza `window.SENSOLAB_API` en `site/index.html`.

El asistente usa **OpenAI** por defecto (`OPENAI_API_KEY`). Modelo por defecto
`gpt-4o-mini`; cámbialo con `ASSISTANT_MODEL`.

---

## Opción B — Cloud (Vercel + Railway + Pages)

## Estado actual

- ✅ **Repo**: https://github.com/joshuabermea0727-cyber/sensolab
- ✅ **Sitio corporativo (GitHub Pages)**: https://joshuabermea0727-cyber.github.io/sensolab/
  — se redepliega solo en cada push que toque `site/` (workflow `.github/workflows/pages.yml`).
- ⏳ **App en Vercel**: pendiente. Importa el repo en https://vercel.com/new
  (si no aparece `sensolab`, primero dale acceso a ese repo desde
  GitHub → Settings → Applications → Vercel). Root directory `.`, framework "Other".
- ⏳ **Backend en Railway**: pendiente (mañana). Pasos abajo.

Tras desplegar Vercel y Railway, edita las URLs en `config.js` y en las dos
líneas de config de `site/index.html`, y haz push.

---

Tres piezas:

| Pieza | Dónde | Qué es |
|---|---|---|
| **App** (`/index.html`, `/remote*.js`, `/config.js`) | Vercel (estático) | La PWA SensoLab Community |
| **Sitio** (`/site/`) | GitHub Pages | La web corporativa de SensoLab Solutions |
| **Backend** (`/backend/`) | Railway | API Express + SQLite + asistente de IA |

El repo ya está en GitHub. Los pasos que faltan:

---

## 1. Backend en Railway

1. **New Project → Deploy from GitHub repo** → elige este repo.
2. Railway detecta `railway.json` y corre `npm start` (que arranca `backend/`).
3. **Variables** (Settings → Variables):
   ```
   NODE_ENV=production
   JWT_SECRET=<una cadena larga y aleatoria>
   CORS_ORIGIN=https://<tu-app>.vercel.app
   ANTHROPIC_API_KEY=<tu clave de api.anthropic.com>   # opcional: activa el bot
   SENSOLAB_DB_PATH=/data/sensolab.db
   ```
4. **Volumen** (para que SQLite no se borre en cada deploy):
   Settings → Volumes → **New Volume**, mount path `/data`.
5. **Sembrar la base una vez**: en la pestaña *Deployments* abre una shell y corre
   `npm run seed`  (o `npm run reset` para empezar de cero).
6. Copia la URL pública, p. ej. `https://sensolab-production.up.railway.app`.

> Sin `ANTHROPIC_API_KEY` el endpoint `/api/assistant` responde con un mensaje de
> "no configurado" y la UI del bot sigue funcionando sin romperse.

---

## 2. App en Vercel

1. **Add New → Project** → importa este repo.
2. Framework preset: **Other**. Root directory: **`.`** (raíz).
   No hay build; Vercel sirve los estáticos. `.vercelignore` excluye `backend/`.
3. Deploy. Copia la URL, p. ej. `https://sensolab-community.vercel.app`.
4. **Conecta la app con el backend**: edita `config.js` en el repo y pon la URL de
   Railway:
   ```js
   window.SENSOLAB_API = 'https://sensolab-production.up.railway.app';
   ```
   Haz commit y push; Vercel redepliega solo.
5. Vuelve a Railway y actualiza `CORS_ORIGIN` con la URL final de Vercel.

---

## 3. Sitio corporativo en GitHub Pages

1. En el repo: **Settings → Pages**.
2. Source: **Deploy from a branch** → branch `main`, carpeta **`/site`** … si esa
   opción no aparece, usa la acción incluida más abajo, o mueve `site/` a `docs/`
   y elige `/docs`.
3. La URL será `https://<usuario-u-org>.github.io/<repo>/`.
4. Edita en `site/index.html` las dos líneas de configuración con las URLs reales:
   ```js
   window.SENSOLAB_APP_URL = 'https://sensolab-community.vercel.app';
   window.SENSOLAB_API      = 'https://sensolab-production.up.railway.app';
   ```

### (Opción) publicar `/site` con GitHub Actions

Si Pages no deja elegir subcarpeta, crea `.github/workflows/pages.yml`:

```yaml
name: Deploy site to Pages
on: { push: { branches: [main], paths: ['site/**'] } }
permissions: { pages: write, id-token: write }
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: { name: github-pages, url: "${{ steps.deployment.outputs.page_url }}" }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/upload-pages-artifact@v3
        with: { path: site }
      - id: deployment
        uses: actions/deploy-pages@v4
```

---

## Checklist final

- [ ] Railway arriba, con volumen en `/data` y `npm run seed` ejecutado.
- [ ] Vercel arriba; `config.js` apunta a Railway; push hecho.
- [ ] `CORS_ORIGIN` en Railway = URL de Vercel.
- [ ] GitHub Pages sirviendo `/site`; URLs de config actualizadas.
- [ ] (Opcional) `ANTHROPIC_API_KEY` en Railway para el asistente de IA.
