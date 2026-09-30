import OpenAI from 'openai';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@marcfargas/odoo-client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============ CONFIG ============
process.env.ODOO_URL = 'http://localhost:8069';
process.env.ODOO_DB = 'odooproject';
process.env.ODOO_USER = 'zain.qayam@gmail.com';
process.env.ODOO_PASSWORD = 'qwerty123';

const GROQ_API_KEY = process.env.GROQ_API_KEY;
if (!GROQ_API_KEY) {
  console.error("Missing GROQ_API_KEY. Run: export GROQ_API_KEY=gsk_xxx");
  process.exit(1);
}

const llm = new OpenAI({
  apiKey: GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

const MODEL = "openai/gpt-oss-120b";

// ============ TOOLS ============

async function findAttachmentsByName(searchName) {
  const odoo = await createClient();
  try {
    const allIds = await odoo.search('ir.attachment', [], { limit: 0 });
    if (allIds.length === 0) return [];

    const batchSize = 200;
    const allAttachments = [];
    for (let i = 0; i < allIds.length; i += batchSize) {
      const batch = allIds.slice(i, i + batchSize);
      const meta = await odoo.read(
        'ir.attachment',
        batch,
        ['name', 'mimetype', 'res_model', 'res_id', 'create_date', 'file_size']
      );
      allAttachments.push(...meta);
    }

    const needle = String(searchName).toLowerCase();
    const matches = allAttachments.filter(
      att => att.name && att.name.toLowerCase().includes(needle)
    );

    return matches.map(m => ({
      id: m.id,
      name: m.name,
      mimetype: m.mimetype,
      file_size_kb: m.file_size ? +(m.file_size / 1024).toFixed(1) : null,
      url: `http://localhost:8069/web/content/${m.id}`,
      create_date: m.create_date,
    }));
  } catch (err) {
    return { error: String(err) };
  } finally {
    odoo.logout();
  }
}

async function getLeaveBalance() {
  const odoo = await createClient();
  try {
    const employees = await odoo.searchRead(
      'hr.employee',
      [['name', 'ilike', 'Zain']],
      ['id', 'name'],
      { limit: 1 }
    );

    if (employees.length === 0) {
      return { error: 'Employee "Zain" not found.' };
    }

    const employeeId = employees[0].id;
    const balanceData = await odoo.searchRead(
      'hr.employee',
      [['id', '=', employeeId]],
      ['remaining_leaves'],
      { limit: 1 }
    );

    return {
      employee: employees[0].name,
      employee_id: employeeId,
      remaining_leaves: balanceData[0]?.remaining_leaves ?? null,
    };
  } catch (err) {
    return { error: String(err) };
  } finally {
    odoo.logout();
  }
}

const tools = { findAttachmentsByName, getLeaveBalance };

// ============ SYSTEM PROMPT ============
const SYSTEM_PROMPT = `
You are an AI Assistant with START, PLAN, ACTION, Observation and Output State.
Wait for the user prompt and first PLAN using available tools.
After planning, take the action with the appropriate tool and wait for observation based on Action.
Once you get the observations, return the AI response based on START prompt and observations.

STRICT RULES:
- You MUST reply with a SINGLE JSON object and NOTHING else.
- Do NOT wrap the JSON in markdown fences.
- Do NOT add commentary before or after the JSON.

Available Tools:
1. function findAttachmentsByName(searchName: string): object[]
   - Searches Odoo attachments by name (case-insensitive substring).
   - Use for any question about any name, HR policy documents, PDFs, files, attachments.

2. function getLeaveBalance(): object
   - Returns remaining leave balance for employee.
   - Use for any question about remaining leaves / leave balance / vacation days.

=== Example 1 (HR Policy) ===
{"type": "user", "user": "Show me the HR policy"}
{"type": "plan", "plan": "Call findAttachmentsByName with 'policy'."}
{"type": "action", "function": "findAttachmentsByName", "input": "policy"}
{"type": "observation", "observation": "[{\\"id\\":12,\\"name\\":\\"HR_Policy.pdf\\",\\"url\\":\\"http://localhost:8069/web/content/12\\"}]"}
{"type": "output", "output": "Here is the HR policy document: HR_Policy.pdf — http://localhost:8069/web/content/12"}

=== Example 2 (Leave balance) ===
{"type": "user", "user": "How many leaves do I have left?"}
{"type": "plan", "plan": "Call getLeaveBalance."}
{"type": "action", "function": "getLeaveBalance", "input": ""}
{"type": "observation", "observation": "{\\"employee\\":\\"name\\",\\"remaining_leaves\\":14}"}
{"type": "output", "output": "You have 14 leaves remaining."}

Now respond to the latest user message. Reply with ONE JSON object only.
`;

// ============ HELPERS ============
function safeJsonParse(text) {
  if (!text) return null;
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  }
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try { return JSON.parse(t.slice(start, end + 1)); } catch {}
    }
    return null;
  }
}

// ============ AGENT RUNNER ============
// Runs the tool-call loop and yields events via a callback.
async function runAgent(userQuery, emit) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify({ type: 'user', user: userQuery }) },
  ];

  for (let step = 0; step < 6; step++) {
    let chat;
    try {
      chat = await llm.chat.completions.create({
        model: MODEL,
        messages,
        response_format: { type: "json_object" },
        temperature: 0.2,
      });
    } catch (err) {
      emit({ kind: 'error', message: err?.message || String(err) });
      return;
    }

    const result = chat.choices[0].message.content;
    messages.push({ role: 'assistant', content: result });

    const call = safeJsonParse(result);
    if (!call) {
      emit({ kind: 'error', message: 'Model did not return valid JSON.' });
      return;
    }

    if (call.type === 'output') {
      emit({ kind: 'output', text: call.output });
      return;
    }

    if (call.type === 'action') {
      emit({ kind: 'action', function: call.function, input: call.input ?? '' });

      const fn = tools[call.function];
      if (!fn) {
        const obs = { error: `Unknown function: ${call.function}` };
        emit({ kind: 'observation', observation: obs });
        messages.push({
          role: 'user',
          content: JSON.stringify({ type: 'observation', observation: JSON.stringify(obs) }),
        });
        continue;
      }

      let observation;
      try {
        observation = await fn(call.input ?? '');
      } catch (e) {
        observation = { error: String(e) };
      }

      emit({ kind: 'observation', observation });

      messages.push({
        role: 'user',
        content: JSON.stringify({
          type: 'observation',
          observation: JSON.stringify(observation),
        }),
      });
      continue;
    }

    // Unknown type — nudge model
    messages.push({
      role: 'user',
      content: JSON.stringify({
        type: 'observation',
        observation: `Unknown message type: ${call.type}. Reply with a valid action or output JSON.`,
      }),
    });
  }

  emit({ kind: 'error', message: 'Tool-call loop exceeded max steps.' });
}

// ============ EXPRESS SERVER ============
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/chat', async (req, res) => {
  const { message } = req.body || {};
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Missing "message" in body.' });
  }

  // Server-Sent Events stream
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (obj) => {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  try {
    await runAgent(message, send);
  } catch (err) {
    send({ kind: 'error', message: err?.message || String(err) });
  } finally {
    send({ kind: 'done' });
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HR Assistant web server running at http://localhost:${PORT}`);
});