const express = require("express");
const cors = require("cors");
const qrcode = require("qrcode");
const { Client, MessageMedia, NoAuth, LocalAuth } = require("whatsapp-web.js");
const multer = require("multer");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

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
      ? headlessEnv.toLowerCase() === "true"
      : false; // Default false since container shows headless:false anyway
  // Try explicit env path first, otherwise probe common Chromium/Chrome locations
  function findChromium() {
    const candidates = [
      process.env.PUPPETEER_EXECUTABLE_PATH,
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/snap/bin/chromium",
    ];
    for (const c of candidates) {
      if (!c) continue;
      try {
        if (fs.existsSync(c)) return c;
      } catch (e) {
        // ignore
      }
    }
    return undefined;
  }

  const executablePath = findChromium();
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

  // Provide safer default Puppeteer args for containers when none are given
  const defaultArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-features=site-per-process"
  ];

  let options = { puppeteer: { headless, pipe: true } };
  if (executablePath) options.puppeteer.executablePath = executablePath;
  if (devtools) options.puppeteer.devtools = true;
  // Merge user-provided args with defaults, prefer user values but remove problematic flags
  const mergedArgs = [];
  const provided = Array.isArray(puppetArgs) ? puppetArgs : [];
  // Avoid single-process which is known to be unstable in containers
  const filteredProvided = provided.filter((a) => a !== "--single-process");
  mergedArgs.push(...defaultArgs);
  for (const a of filteredProvided) if (!mergedArgs.includes(a)) mergedArgs.push(a);
  if (mergedArgs.length) options.puppeteer.args = mergedArgs;

  // Optional LocalAuth persistence (enable by setting USE_LOCAL_AUTH=true)
  const useLocalAuthEnv = process.env.USE_LOCAL_AUTH;
  const useLocalAuth = typeof useLocalAuthEnv === 'string' ? useLocalAuthEnv.toLowerCase() === 'true' : false;
  let sessionPath = process.env.SESSION_PATH || './session';
  // Resolve to absolute path inside container
  try {
    sessionPath = path.resolve(sessionPath);
  } catch (e) {
    // fallback to relative if resolve fails
    sessionPath = './session';
  }

  if (sessionData) {
    options.session = sessionData;
  } else if (useLocalAuth) {
    // Ensure session directory exists and is writable before passing to LocalAuth
    try {
      // create parent dir if needed
      if (!fs.existsSync(sessionPath)) {
        fs.mkdirSync(sessionPath, { recursive: true });
        console.log('Created session directory:', sessionPath);
      }
      // quick writability check
      const testFile = path.join(sessionPath, '.writetest');
      try {
        fs.writeFileSync(testFile, 'ok');
        fs.unlinkSync(testFile);
      } catch (werr) {
        console.warn('Session path not writable, attempting chmod 0777:', sessionPath, werr && werr.message);
        try {
          fs.chmodSync(sessionPath, 0o777);
        } catch (cerr) {
          console.error('Failed to chmod session path:', cerr && cerr.message);
          throw cerr || werr;
        }
      }

      console.log('Using LocalAuth for session persistence. Data path:', sessionPath);
      options.authStrategy = new LocalAuth({ clientId: 'whatsapp-api', dataPath: sessionPath });
    } catch (err) {
      console.error('Cannot use LocalAuth due to session path error, falling back to NoAuth. Error:', err && err.message);
      options.authStrategy = new NoAuth();
    }
  } else {
    // Use NoAuth so we don't persist or restore sessions automatically.
    options.authStrategy = new NoAuth();
  }

  console.log(
    "createClient options:",
    JSON.stringify({
      sessionProvided: !!sessionData,
      headless,
      executablePath: executablePath || null,
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

  // Not using LocalAuth when NoAuth strategy is in use

  // Instantiate client now so event listeners below attach to a valid object
  client = new Client(options);

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
    // Session authenticated successfully
    // Immediately attempt to verify the browser page / window.Store to detect why `ready` may not fire
    (async () => {
      try {
        // If library exposes getState, call it
        if (typeof client.getState === "function") {
          try {
            const st = await client.getState();
            console.log("client.getState() =>", st);
          } catch (gstErr) {
            console.warn("client.getState() error:", gstErr && gstErr.message);
          }
        }

        // Try to locate an active Puppeteer page and test for window.Store
        let page = client.pupPage || null;
        if (!page && client.pupBrowser && typeof client.pupBrowser.pages === "function") {
          try {
            const pages = await client.pupBrowser.pages();
            page = pages && pages.length ? pages[0] : null;
          } catch (pgErr) {
            console.warn("Error getting pages from pupBrowser:", pgErr && pgErr.message);
          }
        }

        if (page) {
          try {
            const hasStore = await page.evaluate(() => !!(window && window.Store));
            console.log("Puppeteer page check: window.Store present =>", hasStore);
            if (hasStore) {
              // Consider client ready if Store is present
              isReady = true;
              qrDataUrl = null;
              console.log("Verified window.Store on page — marking client as ready (temporary verification)");
              if (client && client.info) console.log("Client info after auth verify:", JSON.stringify(client.info));
            }
          } catch (evalErr) {
            console.warn("Error evaluating page for window.Store:", evalErr && evalErr.message);
          }
        } else {
          console.warn("No Puppeteer page available to verify window.Store after authenticated");
        }
      } catch (err) {
        console.warn("Post-auth verification failed:", err && err.message);
      }
    })();

    // If ready event doesn't fire within 45s, force ready as last resort
    setTimeout(() => {
      if (!isReady && client) {
        console.warn("Ready event did not fire after 45s. Forcing ready state as last resort.");
        console.warn("Client may not be fully functional. If send fails, restart with /client/restart");
        isReady = true;
        qrDataUrl = null;
      }
    }, 45000);
  });

  // Log library internal state changes (helpful to see auth/connection transitions)
  client.on('change_state', (state) => {
    try {
      console.log('Event: change_state ->', state);
    } catch (e) {
      console.log('change_state event', e && e.message);
    }
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

  async function initializeClientWithFallback(primaryClient, primaryOptions) {
    try {
      await primaryClient.initialize();
      return true;
    } catch (e) {
      console.error("client.initialize error (primary)", e && e.stack ? e.stack : e);
      // If protocol-level attach failed (Target closed), try fallback launch strategy
      const msg = e && e.message ? e.message : "";
      if (msg.includes("Target closed") || msg.includes("Target.setAutoAttach") || (e && e.name === 'ProtocolError')) {
        console.warn("Puppeteer protocol attach failed, attempting fallback launch with remote debugging (non-pipe)");
        try {
          // Cleanup primary
          try {
            primaryClient.removeAllListeners && primaryClient.removeAllListeners();
            await primaryClient.destroy();
          } catch (cleanupErr) {
            console.warn("Error cleaning up failed primary client:", cleanupErr && cleanupErr.message);
          }

          // Build fallback options safely (avoid JSON.stringify on objects that may contain circular refs)
          const fallbackOptions = {
            puppeteer: Object.assign({}, options.puppeteer || {}),
          };
          // preserve session if provided
          if (options.session) fallbackOptions.session = options.session;
          // Recreate authStrategy in a clean way to avoid circular LocalAuth internals
          if (useLocalAuth) {
            try {
              fallbackOptions.authStrategy = new LocalAuth({ clientId: 'whatsapp-api', dataPath: sessionPath });
            } catch (e) {
              console.warn('Failed to create LocalAuth for fallback, falling back to NoAuth:', e && e.message);
              fallbackOptions.authStrategy = new NoAuth();
            }
          } else {
            fallbackOptions.authStrategy = new NoAuth();
          }

          if (!fallbackOptions.puppeteer) fallbackOptions.puppeteer = {};
          fallbackOptions.puppeteer.pipe = false;
          fallbackOptions.puppeteer.args = Array.isArray(fallbackOptions.puppeteer.args) ? fallbackOptions.puppeteer.args.slice() : [];
          const extra = ["--remote-debugging-port=9222", "--enable-logging=stderr", "--v=1"];
          for (const x of extra) if (!fallbackOptions.puppeteer.args.includes(x)) fallbackOptions.puppeteer.args.push(x);

          // Create a new client instance with fallback options
          const fallbackClient = new Client(fallbackOptions);

          // Re-register minimal listeners to capture logs during fallback
          fallbackClient.on("qr", (qr) => {
            qrcode.toDataURL(qr).then((url) => { qrDataUrl = url; console.log("QR received (fallback), visit /qr to view"); }).catch((err)=>console.error("QR toDataURL error (fallback)", err));
          });

          try {
            await fallbackClient.initialize();
            // if succeed, replace global client
            client = fallbackClient;
            console.log("Fallback client initialized successfully (remote-debugging)");
            return true;
          } catch (fbErr) {
            console.error("Fallback client initialize also failed:", fbErr && fbErr.stack ? fbErr.stack : fbErr);
            try { fallbackClient.removeAllListeners && fallbackClient.removeAllListeners(); await fallbackClient.destroy(); } catch (xx) {}
            return false;
          }
        } catch (outer) {
          console.error("Error during fallback attempt:", outer && outer.stack ? outer.stack : outer);
          return false;
        }
      }

      return false;
    }
  }

  // attempt primary initialize, with fallback on specific protocol errors
  (async () => {
    const ok = await initializeClientWithFallback(client, options);
    if (!ok) {
      console.error("Failed to initialize WhatsApp client (both primary and fallback). Check Chromium installation and container flags.");
    }
  })();
}

// No session force-create helper needed in NoAuth mode.

// NoAuth mode: do not restore sessions on startup. Client will be created on demand.
console.log("NoAuth mode: not restoring sessions on startup; client will be created on demand when needed.");

// Periodic health check - log client status every 60 seconds
setInterval(() => {
  if (client) {
    console.log(`[Health Check] Client status - Ready: ${isReady}, Has client: ${!!client}`);
    if (isReady && client.info) {
      console.log(`[Health Check] Connected as: ${client.info.pushname || 'Unknown'} (${client.info.wid?.user || 'N/A'})`);
    }
  }
}, 60000);

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

// Diagnostic endpoint to help debug Puppeteer/Chromium availability
app.get('/diagnose', (req, res) => {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH || null,
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/snap/bin/chromium",
  ];
  const candidateStatuses = candidates.map((p) => ({ path: p, exists: p ? !!fs.existsSync(p) : false }));

  res.json({
    env: {
      HEADLESS: process.env.HEADLESS || null,
      PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH || null,
      PUPPETEER_ARGS: process.env.PUPPETEER_ARGS || null,
      PUPPETEER_DEVTOOLS: process.env.PUPPETEER_DEVTOOLS || null,
      USE_LOCAL_AUTH: process.env.USE_LOCAL_AUTH || null,
    },
    candidates: candidateStatuses,
    chosenExecutable: (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) ? process.env.PUPPETEER_EXECUTABLE_PATH : (candidateStatuses.find(c=>c.exists)?.path || null),
    memoryUsage: process.memoryUsage(),
    clientPresent: !!client,
    isReady: !!isReady,
  });
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
