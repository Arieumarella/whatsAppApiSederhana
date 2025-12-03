# WhatsApp API (Simple)

# WhatsApp API (Simple)

Simple WhatsApp API using `whatsapp-web.js` and `express`.

Quick start (PowerShell):

```powershell
cd d:\PointOfSale\WhatsApp-API
npm install
npm start
```

Endpoints:

- `GET /status` — returns `{ ready: true|false }`
- `GET /qr` — returns `{ qr: dataUrl }` while not authenticated; open the data URL in a browser to scan QR
- `POST /send` — send message. JSON body: `{ "number": "628123...", "message": "Hello" }`
- `POST /send` — send message. JSON body: `{ "number": "628123...", "message": "Hello" }`
  - Supported input formats for `number`:
    - Local Indonesian format starting with `0`, e.g. `089530518554` (will be normalized to `62...`).
    - International with `+`, e.g. `+6289530518554` (the `+` will be removed).
    - International without plus, e.g. `6289530518554`.
- `POST /session/restore` — restore a saved session. Body JSON: `{ "session": { ... } }`. The server will save it to `session.json` and reinitialize the client.
- `POST /client/restart` — force restart the client (destroys any previous client, creates a fresh one and generates a new QR if no session exists).
- `POST /client/restart` — force restart the client (destroys any previous client, creates a fresh one and generates a new QR if no session exists).
- `POST /send-file` — send a PDF file to a number. Supports multipart upload (`file`), `fileUrl`, or `fileBase64` in JSON. Example multipart: form field `file` (binary), `number`, optional `caption`.

Single session behavior:

- The server supports only one active session at a time (stored in `session.json`).
- When you restore/import a session via `POST /session/restore`, any existing session file is removed and the previous client instance is destroyed before the new session is applied. This keeps the server light and prevents multiple headless browser instances from running.

Example using `curl` (PowerShell `Invoke-RestMethod` alternative):

```powershell
# Using curl
curl -X POST http://localhost:3000/send -H "Content-Type: application/json" -d '{"number":"628123456789","message":"Halo dari API"}'

# Using Invoke-RestMethod
$body = @{ number = '628123456789'; message = 'Halo dari API' } | ConvertTo-Json
Invoke-RestMethod -Uri http://localhost:3000/send -Method Post -Body $body -ContentType 'application/json'
```

Notes:

- The server uses a legacy `session.json` file to persist/restore sessions. After a successful authentication the session object is saved to `session.json`.
- When a new client is created (either on startup or via restore/restart endpoints), any previous client instance is destroyed first to avoid multiple running browser instances.
- If you want to export/import a session from another machine, POST the session object to `/session/restore`.
