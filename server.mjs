import 'dotenv/config';
import http from 'http';
import { WebSocketServer } from 'ws';

// =============================
// CONFIG
// =============================
const PORT = process.env.PORT || 10000;
const EASYBUSY_BASE_URL =
  process.env.EASYBUSY_BASE_URL || 'https://api-b2b.easybusy.software';
const EASYBUSY_API_KEY = process.env.EASYBUSY_API_KEY;

if (!EASYBUSY_API_KEY) {
  console.error('❌ Missing EASYBUSY_API_KEY env var');
  process.exit(1);
}

// =============================
// EASYBUSY FETCH WRAPPER
// =============================
async function easybusyFetch(path, { method = 'GET', query, body } = {}) {
  const url = new URL(path, EASYBUSY_BASE_URL);

  if (query) {
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null) {
        url.searchParams.set(k, String(v));
      }
    });
  }

  const res = await fetch(url.toString(), {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': EASYBUSY_API_KEY
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  let json;

  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }

  if (!res.ok) {
    throw new Error(
      `EasyBusy ${method} ${url.pathname} failed (${res.status}): ${text}`
    );
  }

  return json;
}

// =============================
// TOOLS DEFINICIJA
// =============================
const tools = [
  {
    name: 'easybusy_company_features',
    description: 'GET /v2/company/features',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'easybusy_company_languages',
    description: 'GET /v2/company/languages',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'easybusy_bookable_services',
    description: 'GET /v2/simple-booking/bookable-services',
    inputSchema: {
      type: 'object',
      properties: { languageCode: { type: 'string' } },
      required: ['languageCode']
    }
  },
  {
    name: 'easybusy_bookable_doctors',
    description: 'GET /v2/simple-booking/bookable-doctors',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'easybusy_available_slots',
    description: 'GET /v2/simple-booking/available-slots',
    inputSchema: {
      type: 'object',
      properties: {
        languageCode: { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
        serviceId: { type: 'integer' },
        doctorId: { type: 'integer' }
      },
      required: ['languageCode', 'from', 'to', 'serviceId', 'doctorId']
    }
  },
  {
    name: 'easybusy_request_slot',
    description: 'POST /v2/simple-booking/request-slot/{slotId}',
    inputSchema: {
      type: 'object',
      properties: {
        slotId: { type: 'integer' },
        serviceId: { type: 'integer' },
        message: { type: 'string' },
        patientInfo: { type: 'object' }
      },
      required: ['slotId', 'serviceId', 'patientInfo']
    }
  }
];

// =============================
// TOOL CALL HANDLER
// =============================
async function handleToolCall(name, args) {
  switch (name) {
    case 'easybusy_company_features':
      return await easybusyFetch('/v2/company/features');

    case 'easybusy_company_languages':
      return await easybusyFetch('/v2/company/languages');

    case 'easybusy_bookable_services':
      return await easybusyFetch('/v2/simple-booking/bookable-services', {
        query: { languageCode: args.languageCode }
      });

    case 'easybusy_bookable_doctors':
      return await easybusyFetch('/v2/simple-booking/bookable-doctors');

    case 'easybusy_available_slots':
      return await easybusyFetch('/v2/simple-booking/available-slots', {
        query: {
          languageCode: args.languageCode,
          from: args.from,
          to: args.to,
          serviceId: args.serviceId,
          doctorId: args.doctorId
        }
      });

    case 'easybusy_request_slot':
      return await easybusyFetch(
        `/v2/simple-booking/request-slot/${args.slotId}`,
        {
          method: 'POST',
          body: {
            serviceId: args.serviceId,
            message: args.message ?? '',
            patientInfo: args.patientInfo
          }
        }
      );

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// =============================
// HTTP + WEBSOCKET SERVER
// =============================
const server = http.createServer((req, res) => {
  // Health check
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  // MCP UI EXPECTS THIS!!!
  if (req.url === '/mcp' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ready', mcp: true }));
    return;
  }

  res.writeHead(404);
  res.end();
});

// WebSocket endpoint
const wss = new WebSocketServer({ server, path: '/mcp' });

wss.on('connection', ws => {
  ws.on('message', async message => {
    let data;
    try {
      data = JSON.parse(message.toString());
    } catch {
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Invalid JSON' }
        })
      );
      return;
    }

    const { id, method, params } = data;

    try {
      if (method === 'tools/list') {
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: { tools, nextCursor: null }
          })
        );
        return;
      }

      if (method === 'tools/call') {
        const { name, arguments: args } = params || {};
        const result = await handleToolCall(name, args || {});
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            result
          })
        );
        return;
      }

      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: 'Unknown method' }
        })
      );
    } catch (err) {
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32000,
            message: err.message || 'Internal MCP error'
          }
        })
      );
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 MCP server listening on port ${PORT}`);
});
