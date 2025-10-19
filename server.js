import express from "express";
import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());

// IMPORTANT for Render: bind to provided PORT
const PORT = process.env.PORT || 3000;

// Initialize OpenAI client (expects OPENAI_API_KEY env var on Render)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Demo services and simple tool "router" ---
const SERVICES = { "Damenhaarschnitt": 45, "Herrenhaarschnitt": 30, "Coloration": 120, "Besichtigung Maler": 60 };

async function toolRouter(name, args) {
  const a = typeof args === "string" ? JSON.parse(args || "{}") : (args || {});

  if (name === "getAvailability") {
    const dur = a.durationMinutes ?? (SERVICES[a.service] ?? 60);
    const start = new Date(a.dateFrom || Date.now());
    const out = [];
    for (let i = 0; i < 3; i++) {
      const s = new Date(start.getTime() + i * 2 * 3600 * 1000);
      out.push({ start: s.toISOString(), end: new Date(s.getTime() + dur * 60 * 1000).toISOString() });
    }
    return { slots: out, durationMinutes: dur };
  }

  if (name === "createBooking") {
    const id = "bk_" + Math.random().toString(36).slice(2, 9);
    return { bookingId: id, ...a, end: new Date(new Date(a.start).getTime() + a.durationMinutes * 60 * 1000).toISOString() };
  }

  if (name === "cancelBooking") return { bookingId: a.bookingId, status: "cancelled", reason: a.reason || null };

  if (name === "getPriceEstimate") {
    const base = a.paintQuality === "premium" ? 10.5 : 7.5;
    const h = Math.max(1, (a.ceilingHeight ?? 2.5) / 2.5);
    const rooms = a.rooms ?? 1;
    const roomFactor = 1 + Math.max(0, rooms - 1) * 0.05;
    const travel = a.locationPostalCode ? 25 : 0;
    const net = a.squareMeters * base * h * roomFactor + travel;
    const vat = +(net * 0.19).toFixed(2);
    const gross = +(net + vat).toFixed(2);
    return { estimate: { net: +net.toFixed(2), vat, gross }, disclaimer: "Unverbindliche Richtpreis-Schätzung. Vor-Ort-Besichtigung empfohlen." };
  }

  if (name === "sendMessage") return { delivered: true };

  return { error: `Unknown tool ${name}` };
}

const SYSTEM_PROMPT = `Du bist „TerminPilot“, ein deutscher KI-Agent für Friseursalons und Malerbetriebe.
Ziele: 1) Wunsch verstehen, 2) Verfügbarkeit prüfen, 3) Termin buchen/verschieben/stornieren, 4) Kontaktdaten sammeln, 5) klare Bestätigung.
Stil: freundlich, präzise, strukturiert (Europe/Berlin).
Tools: getAvailability, createBooking, cancelBooking, getPriceEstimate, sendMessage.
Bei fehlenden Infos gezielt nachfragen (max. 2 Rückfragen).`;

const TOOLS = [
  {
    "type": "function",
    "function": {
      "name": "getAvailability",
      "description": "Gibt freie Zeitfenster für eine Leistung zurück.",
      "parameters": {
        "type": "object",
        "properties": {
          "service": {"type":"string"},
          "locationId": {"type":"string"},
          "staffId": {"type":"string"},
          "dateFrom": {"type":"string","format":"date-time"},
          "dateTo": {"type":"string","format":"date-time"},
          "durationMinutes": {"type":"integer"}
        },
        "required": ["service","dateFrom","dateTo"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "createBooking",
      "description": "Legt einen Termin an.",
      "parameters": {
        "type": "object",
        "properties": {
          "service":{"type":"string"},
          "start":{"type":"string","format":"date-time"},
          "durationMinutes":{"type":"integer"},
          "locationId":{"type":"string"},
          "staffId":{"type":"string"},
          "customer":{
            "type":"object",
            "properties":{
              "name":{"type":"string"},
              "email":{"type":"string"},
              "phone":{"type":"string"}
            },
            "required":["name"]
          },
          "notes":{"type":"string"}
        },
        "required":["service","start","durationMinutes","customer"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "cancelBooking",
      "description": "Storniert einen Termin.",
      "parameters": {
        "type": "object",
        "properties": {
          "bookingId":{"type":"string"},
          "reason":{"type":"string"}
        },
        "required":["bookingId"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "getPriceEstimate",
      "description": "Gibt eine unverbindliche Maler-Richtpreisschätzung.",
      "parameters": {
        "type": "object",
        "properties": {
          "squareMeters":{"type":"number"},
          "rooms":{"type":"integer"},
          "ceilingHeight":{"type":"number"},
          "surface":{"type":"string"},
          "paintQuality":{"type":"string","enum":["basic","premium"]},
          "locationPostalCode":{"type":"string"}
        },
        "required":["squareMeters","paintQuality"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "sendMessage",
      "description": "Bestätigung per E-Mail/SMS/WhatsApp verschicken.",
      "parameters": {
        "type": "object",
        "properties": {
          "channel":{"type":"string","enum":["email","sms","whatsapp"]},
          "to":{"type":"string"},
          "subject":{"type":"string"},
          "body":{"type":"string"}
        },
        "required":["channel","to","body"]
      }
    }
  }
];

// Chat endpoint
app.post("/chat", async (req, res) => {
  try {
    const userMessage = req.body?.userMessage || "Hallo!";
    let response = await openai.responses.create({
      model: "gpt-5.1",
      system: SYSTEM_PROMPT,
      input: [{ role: "user", content: userMessage }],
      tools: TOOLS,
      tool_choice: "auto"
    });

    // handle tool calls loop
    const collectToolCalls = (out=[]) => (response.output || []).filter(o => o.type === "tool_call");
    let toolCalls = collectToolCalls();
    while (toolCalls.length) {
      const results = [];
      for (const c of toolCalls) {
        const result = await toolRouter(c.name, c.arguments);
        results.push({ type: "tool_result", tool_call_id: c.id, output: JSON.stringify(result) });
      }
      response = await openai.responses.create({ model: "gpt-5.1", input: results });
      toolCalls = collectToolCalls();
    }

    res.json({ ok: true, reply: response.output_text });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/", (_, res) => res.send("TerminPilot Agent is running."));
app.listen(PORT, () => console.log(`Agent listening on :${PORT}`));
