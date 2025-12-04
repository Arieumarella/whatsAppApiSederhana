const express = require("express");
const cors = require("cors");
const qrcode = require("qrcode");
const { Client, MessageMedia, NoAuth } = require("whatsapp-web.js");
const multer = require("multer");
const fetch = require("node-fetch");
require('dotenv').config();

const app = express();
app.use(express.json());
// Enable CORS - allow all origins
app.use(cors());
app.options("*", cors());

const PORT = process.env.PORT || 5000;

let qrDataUrl = null;
let isReady = false;
let client = null;
let creatingClientPromise = null;

// Global handlers to log and avoid crashing on unhandled rejections/exceptions
process.on("unhandledRejection", (reason, p) => {
  console.warn(
    "Unhandled Rejection at:",
    p,
    "reason:",
    reason && reason.stack ? reason.stack : reason
  );
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err && err.stack ? err.stack : err);
});

// No session file helpers needed in NoAuth mode.

// Normalize phone numbers to international format without plus sign
// Examples:
//  - "089530518554" -> "6289530518554" (leading 0 replaced with 62)
//  - "+6289530518554" -> "6289530518554"
//  - "6289530518554" -> "6289530518554"
function normalizeNumber(input) {
  if (!input || typeof input !== "string") return null;
  // If already contains @ (chat id), return as-is
  if (input.includes("@")) return input;

  // Remove all non-digit characters, but keep leading + for detection
  const cleaned = input.trim();
  // remove spaces, dashes, parentheses
  let digits = cleaned.replace(/[^+0-9]/g, "");
  if (!digits) return null;

  // Remove leading plus
  if (digits.startsWith("+")) digits = digits.slice(1);

  // If starts with 0, replace with country code 62 (Indonesia)
  if (digits.startsWith("0")) {
    digits = "62" + digits.slice(1);
  }

  // Basic validation: must be at least 8 digits after normalization
  const onlyDigits = digits.replace(/\D/g, "");
  if (onlyDigits.length < 8) return null;

  return onlyDigits;
}

async function createClient(sessionData = null) {
  
  if (client) {
    try {
      await client.destroy();
      console.log("Previous client destroyed");
    } catch (e) {
      console.error("Error destroying previous client", e);
    }
    client = null;
    isReady = false;
    qrDataUrl = null;
  }

  // Puppeteer options can be controlled via env vars for debugging
  const headlessEnv = process.env.HEADLESS;
  const headless =
    typeof headlessEnv === "string"
      ? headlessEnv.toLowerCase() !== "false"
      : false; // Default to false (headful) for better debugging in container
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
  // Optional env to auto-open DevTools: PUPPETEER_DEVTOOLS=true
  const devtoolsEnv = process.env.PUPPETEER_DEVTOOLS;
  const devtools =
    typeof devtoolsEnv === "string" ? devtoolsEnv.toLowerCase() === "true" : false;
  // Optional extra args (comma-separated): PUPPETEER_ARGS="--no-sandbox,--disable-setuid-sandbox"
  const argsEnv = process.env.PUPPETEER_ARGS;
  const puppetArgs =
    typeof argsEnv === "string" && argsEnv.trim()
      ? argsEnv.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;

  let options = { puppeteer: { headless } };
  if (executablePath) options.puppeteer.executablePath = executablePath;
  if (devtools) options.puppeteer.devtools = true;
  if (puppetArgs && puppetArgs.length) options.puppeteer.args = puppetArgs;

  if (sessionData) {
    options.session = sessionData;
  } else {
    // Use NoAuth so we don't persist or restore sessions automatically.
    options.authStrategy = new NoAuth();
  }

  console.log(
    "createClient options:",
    JSON.stringify({
      sessionProvided: !!sessionData,
      headless,
      executablePath: !!executablePath,
      devtools,
      puppetArgs: !!(puppetArgs && puppetArgs.length),
    })
  );
  
  // Log memory usage for debugging container resource issues
  const memUsage = process.memoryUsage();
  console.log("Memory usage (MB):", {
    rss: Math.round(memUsage.rss / 1024 / 1024),
    heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
    heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
    external: Math.round(memUsage.external / 1024 / 1024)
  });

  client = new Client(options);
  // Not using LocalAuth when NoAuth strategy is in use

  client.on("qr", (qr) => {
    qrcode
      .toDataURL(qr)
      .then((url) => {
        qrDataUrl = url;
        console.log("QR received, visit /qr to view");
      })
      .catch((err) => console.error("QR toDataURL error", err));
  });

  client.on("loading_screen", (percent, message) => {
    console.log(`loading_screen: ${percent}% - ${message}`);
  });

  client.on("initial_data", (data) => {
    // some versions may emit initial data; log lightly
    console.log("Event: initial_data received");
  });

  client.on("authenticated", (session) => {
    try {
      console.log("Event: authenticated — session type:", typeof session);
      console.log(
        "Event: authenticated — session preview:",
        session ? JSON.stringify(session).slice(0, 200) : session
      );
    } catch (err) {
      console.log("Authenticated event (unable to stringify session)", err);
    }
    // If LocalAuth is used, it handles persistence automatically. No manual write here.
    
    // Workaround: Sometimes in containers, 'ready' event doesn't fire after authenticated.
    // Set a timeout to check if ready fired; if not, try to recover.
    setTimeout(async () => {
      if (!isReady && client) {
        console.error("CRITICAL: Client authenticated but 'ready' event not received after 30s.");
        console.error("Possible causes: Chromium crashed, insufficient memory, or WhatsApp Web issue.");
        console.error("Attempting automatic recovery by recreating client...");
        
        // Destroy stuck client
        try {
          client.removeAllListeners && client.removeAllListeners();
          await client.destroy();
          console.log("Stuck client destroyed.");
        } catch (e) {
          console.error("Failed to destroy stuck client:", e);
        }
        
        client = null;
        isReady = false;
        qrDataUrl = null;
        
        // Auto-recreate with slight delay
        console.log("Waiting 3 seconds before recreating client...");
        await new Promise(r => setTimeout(r, 3000));
        
        console.log("Creating new client automatically. QR will be available at /qr");
        try {
          await createClient();
        } catch (err) {
          console.error("Failed to auto-recreate client:", err);
        }
      }
    }, 30000);
  });

  // Additional auth-success listener (if emitted by library)
  client.on("auth_success", () => {
    console.log("Event: auth_success");
  });

  client.on("ready", () => {
    isReady = true;
    qrDataUrl = null;
    console.log("WhatsApp client ready");
    // Log client info for verification
    if (client && client.info) {
      console.log("Client info:", JSON.stringify(client.info));
    }
  });

  client.on("auth_failure", (msg) => {
    console.error("Auth failure:", msg);
    console.error("This usually means QR scan failed or session is invalid.");
    isReady = false;
    qrDataUrl = null;
  });

  client.on("disconnected", (reason) => {
    console.log("Client disconnected:", reason);
    console.log("Reason details:", JSON.stringify(reason));
    isReady = false;
    qrDataUrl = null;
    // If disconnected unexpectedly, client may need to be recreated
    if (client) {
      console.log("Cleaning up disconnected client resources...");
      try {
        client.removeAllListeners && client.removeAllListeners();
      } catch (e) {
        console.error("Error removing listeners on disconnect:", e);
      }
    }
  });

  try {
    client.initialize();
  } catch (e) {
    console.error("client.initialize error", e);
  }
}

// No session force-create helper needed in NoAuth mode.

// NoAuth mode: do not restore sessions on startup. Client will be created on demand.
console.log("NoAuth mode: not restoring sessions on startup; client will be created on demand when needed.");

app.get("/status", (req, res) => {
  res.json({ ready: isReady });
});

app.get("/qr", async (req, res) => {
  // In NoAuth mode: if client is already ready and user requests QR,
  // destroy the existing client to force creation of a fresh client and QR.
  if (isReady) {
    console.log("Client is ready but /qr was requested — forcing new client to generate QR");
    try {
      if (client) {
        client.removeAllListeners && client.removeAllListeners();
        await client.destroy();
        console.log("Existing client destroyed to force new QR");
      }
    } catch (e) {
      console.warn("Error destroying client before forcing new QR:", e && e.message ? e.message : e);
    }
    // small delay to let chrome release resources (helps avoid ProtocolError on some systems)
    await new Promise((r) => setTimeout(r, 500));
    client = null;
    isReady = false;
    qrDataUrl = null;
  }

  // If QR already generated, return it
  if (qrDataUrl) return res.json({ qr: qrDataUrl });

  // If no client exists yet, create it on demand to generate a QR
  try {
    if (!client) {
      if (!creatingClientPromise) {
        creatingClientPromise = createClient();
        // clear the promise once done
        creatingClientPromise.finally(() => {
          creatingClientPromise = null;
        });
      }
      await creatingClientPromise;
    }
  } catch (err) {
    console.error("Failed to create client on /qr request", err);
    return res.status(500).json({ error: "Failed to initialize client" });
  }
  // No session removal logic in NoAuth mode.
  // If qrDataUrl already set after createClient, return it
  if (qrDataUrl) return res.json({ qr: qrDataUrl });

  // Wait for 'qr' event (up to timeout) so the request can receive QR in same response
  try {
    const qr = await new Promise((resolve, reject) => {
      const timeoutMs = 20000; // wait up to 20s
      let timer = setTimeout(() => {
        client && client.removeListener("qr", onQr);
        reject(new Error("QR timeout"));
      }, timeoutMs);

      function onQr(rawQr) {
        clearTimeout(timer);
        // convert raw QR to data URL and resolve
        qrcode
          .toDataURL(rawQr)
          .then((url) => resolve(url))
          .catch((err) => reject(err));
      }

      // if client is present, listen once
      if (client) {
        client.once("qr", onQr);
      } else {
        clearTimeout(timer);
        reject(new Error("Client not initialized"));
      }
    });

    return res.json({ qr });
  } catch (e) {
    return res
      .status(202)
      .json({ message: "QR not yet generated; check server logs" });
  }
});

app.post("/send", async (req, res) => {
  const { number, message } = req.body;
  if (!number || !message)
    return res.status(400).json({ error: "Missing number or message" });

  // normalize number before sending
  const normalized = normalizeNumber(number);
  if (!normalized)
    return res.status(400).json({ error: "Invalid phone number format" });
  const targetChatId = normalized.includes("@")
    ? normalized
    : `${normalized}@c.us`;

  try {
    if (!client)
      return res
        .status(500)
        .json({ ok: false, error: "Client not initialized" });
    const sent = await client.sendMessage(targetChatId, message);
    res.json({ ok: true, id: sent.id._serialized });
  } catch (err) {
    console.error("send error", err);
    res.status(500).json({ ok: false, error: err.toString() });
  }
});

// Restore session by providing session JSON in body { session: { ... } }
// Session restore endpoint removed in NoAuth mode.

// Force restart client (destroy previous then create new without session)
app.post("/client/restart", async (req, res) => {
  try {
    if (client) {
      try {
        client.removeAllListeners && client.removeAllListeners();
        await client.destroy();
        console.log("Existing client destroyed (restart)");
      } catch (e) {
        console.warn("Failed to destroy client on restart:", e && e.message);
      }
      client = null;
      isReady = false;
      qrDataUrl = null;
    }

    await createClient();
    return res.json({ ok: true, message: "Client restarted (new client created)" });
  } catch (err) {
    console.error("Restart client error", err);
    return res.status(500).json({ ok: false, error: err.toString() });
  }
});

// Multer setup for multipart uploads (in-memory)
const upload = multer({ storage: multer.memoryStorage() });

// POST /send-file
// Supports multipart form upload (field `file`), JSON { fileUrl }, or JSON { fileBase64, filename, mimeType }
app.post("/send-file", upload.single("file"), async (req, res) => {
  // Debug: log headers, body, and file info for troubleshooting
  console.log("--- /send-file request ---");
  console.log("Headers:", req.headers);
  console.log("Body:", req.body);
  if (req.file) {
    console.log("File field:", {
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      bufferLength: req.file.buffer ? req.file.buffer.length : null,
    });
  } else {
    console.log("No file uploaded (req.file is undefined)");
  }

  const { number, caption } = req.body;
  if (!number) return res.status(400).json({ error: "Missing number" });

  const normalized = normalizeNumber(number);
  if (!normalized)
    return res.status(400).json({ error: "Invalid phone number format" });
  const targetChatId = normalized.includes("@")
    ? normalized
    : `${normalized}@c.us`;

  if (!client)
    return res.status(500).json({ ok: false, error: "Client not initialized" });
  if (!isReady)
    return res.status(503).json({
      ok: false,
      error: "Client not ready; try again in a few seconds",
    });

  try {
    let buffer = null;
    let mimeType = "application/pdf";
    let filename = "file.pdf";

    if (req.file && req.file.buffer) {
      buffer = req.file.buffer;
      mimeType = req.file.mimetype || mimeType;
      filename = req.file.originalname || filename;
    } else if (req.body.fileBase64) {
      const b64 = req.body.fileBase64;
      const match = /^data:(.+);base64,(.+)$/.exec(b64);
      let base64data = b64;
      if (match) {
        mimeType = match[1] || mimeType;
        base64data = match[2];
      } else if (req.body.mimeType) {
        mimeType = req.body.mimeType;
      }
      buffer = Buffer.from(base64data, "base64");
      if (req.body.filename) filename = req.body.filename;
    } else if (req.body.fileUrl) {
      const resp = await fetch(req.body.fileUrl);
      if (!resp.ok)
        return res.status(400).json({ error: "Failed to fetch file from URL" });
      const arrayBuf = await resp.arrayBuffer();
      buffer = Buffer.from(arrayBuf);
      mimeType = resp.headers.get("content-type") || mimeType;
      const urlParts = req.body.fileUrl.split("/");
      filename = urlParts[urlParts.length - 1] || filename;
    } else {
      return res.status(400).json({
        error:
          "No file provided. Use multipart upload (file), fileBase64, or fileUrl.",
      });
    }

    if (!mimeType || !mimeType.includes("pdf")) {
      return res.status(400).json({
        error: "Only PDF files are allowed (mime-type application/pdf)",
      });
    }

    if (!buffer || buffer.length === 0)
      return res.status(400).json({ error: "Empty file" });

    const media = new MessageMedia(
      mimeType,
      buffer.toString("base64"),
      filename
    );
    console.log("Sending file to", targetChatId, "file:", filename);
    const sent = await client.sendMessage(targetChatId, media, {
      caption: caption || "",
    });
    console.log("File sent successfully:", sent.id._serialized);
    return res.json({ ok: true, id: sent.id._serialized });
  } catch (err) {
    console.error("send-file error:", err.message || err);
    // Common Puppeteer errors that are temporary
    if (err.message && err.message.includes("Evaluation failed")) {
      return res.status(503).json({
        ok: false,
        error: "WhatsApp client evaluation error; try again",
      });
    }
    return res.status(500).json({ ok: false, error: err.toString() });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
