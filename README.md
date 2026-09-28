# Vaporly Vape Shop

## Run the app

Install dependencies, then start the frontend and SQLite API together:

```powershell
npm install
npm run dev:full
```

The frontend runs on `http://localhost:5173` and the API runs on `http://localhost:4000`.

## Database

The API uses SQLite at `server/data/vaporly.sqlite`. It creates the `users`, `tokens`, and `products` tables automatically on startup. Existing records in `server/data/store.json` are imported once when the SQLite database is empty, so the previous admin account is preserved.

The local default admin account is:

- Email: `admin@vaporly.local`
- Password: `ChangeThisAdminPassword123!`

Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env` before using this outside local development. The SQLite file is intentionally ignored by git because it contains local user and product data.

## API health check

```powershell
Invoke-RestMethod http://localhost:4000/api/health
```

The response includes `"database": "sqlite"` when the SQLite-backed API is running.

## Original Vite notes

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and Oxlint's TypeScript related rules in your project.
# sir_chad
