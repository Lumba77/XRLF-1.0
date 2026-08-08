#!/usr/bin/env node
/**
 * Foveated Memory — MCP Server
 * Exposes the foveated memory store as MCP tools for LM Studio, Cline, Cursor, Claude Desktop, etc.
 * Uses raw stdio JSON-RPC 2.0 (no SDK deps needed).
 *
 * Register in any IDE's mcp.json:
 *   "foveated-memory": { "command": "node", "args": ["<abs-path>/mcp-server.js"] }
 *
 * Optional env vars:
 *   FM_WORKSPACE  — workspace/namespace (default: "default")
 *   FM_DATA_DIR   — path to memory_data dir (default: ./memory_data next to this file)
 */

'use strict';

const path = require('path');
const { MemoryStore } = require('./memory/store');

// ── Config ────────────────────────────────────────────────────────────────────
const WORKSPACE  = process.env.FM_WORKSPACE || 'default';
const DATA_DIR   = process.env.FM_DATA_DIR  || path.join(__dirname, 'memory_data');
const SERVER_NAME    = 'foveated-memory';
const SERVER_VERSION = '1.0.0';

// ── Store ─────────────────────────────────────────────────────────────────────
const store = new MemoryStore(DATA_DIR, WORKSPACE);

// ── MCP Tool Definitions ──────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'memory_save',
    description: 'Save a message turn to persistent foveated memory. Call this after each assistant response to build long-term recall.',
    inputSchema: {
      type: 'object',
      properties: {
        role:    { type: 'string', enum: ['user', 'assistant', 'system'], description: 'Who sent this message' },
        content: { type: 'string', description: 'The message content to save' },
        session: { type: 'string', description: 'Optional session ID to group related turns (default: today)' }
      },
      required: ['role', 'content']
    }
  },
  {
    name: 'memory_recall',
    description: 'Semantically search persistent memory using TF-IDF. Use this when the user references past conversations, asks "do you remember", or when context seems missing.',
    inputSchema: {
      type: 'object',
      properties: {
        query:  { type: 'string', description: 'Keywords or phrase to search memory for' },
        top_n:  { type: 'number', description: 'Max results to return (default: 5)' }
      },
      required: ['query']
    }
  },
  {
    name: 'memory_recent',
    description: 'Retrieve the N most recent stored messages across all sessions. Useful for resuming context at session start.',
    inputSchema: {
      type: 'object',
      properties: {
        n: { type: 'number', description: 'Number of recent messages to fetch (default: 6, max recommended: 10)' }
      }
    }
  },
  {
    name: 'memory_summary',
    description: 'Get a foveated ring snapshot: recent turns verbatim + compressed older history. Use ONLY at session start, not on every turn.',
    inputSchema: {
      type: 'object',
      properties: {
        fovea_count: { type: 'number', description: 'How many recent messages to keep verbatim (default: 6)' }
      }
    }
  },
  {
    name: 'memory_stats',
    description: 'Return the total number of stored messages and workspace info.',
    inputSchema: { type: 'object', properties: {} }
  }
];

// ── Tool Handlers ─────────────────────────────────────────────────────────────
async function handleTool(name, args) {
  switch (name) {

    case 'memory_save': {
      const sessionId = args.session || new Date().toISOString().slice(0, 10);
      await store.store(sessionId, args.role, args.content, Date.now());
      const total = await store.count();
      return { saved: true, workspace: WORKSPACE, total_messages: total };
    }

    case 'memory_recall': {
      const topN = args.top_n || 5;
      const results = await store.search(args.query, topN);
      if (!results.length) return { results: [], message: 'No matching memories found.' };
      return {
        results: results.map(r => {
          const raw = r.message.content;
          const text = Array.isArray(raw)
            ? raw.filter(p => p && typeof p.text === 'string').map(p => p.text).join('\n')
            : String(raw || '');
          return {
            score:   Math.round(r.score * 1000) / 1000,
            role:    r.message.role,
            content: text,
            age:     _relativeAge(r.message.timestamp)
          };
        })
      };
    }

    case 'memory_recent': {
      const n = Math.min(args.n || 6, 10); // hard cap at 10 to protect context window
      const msgs = await store.getRecent(n);
      return {
        count: msgs.length,
        messages: msgs.map(m => ({
          role:    m.role,
          content: m.content,
          age:     _relativeAge(m.timestamp)
        }))
      };
    }

    case 'memory_summary': {
      const foveaCount = Math.min(args.fovea_count || 4, 6);
      const all = await store.getRecent(20); // cap at 20 total to protect context window
      if (!all.length) return { summary: '[No memory stored yet]' };

      const fovea   = all.slice(0, foveaCount);
      const older   = all.slice(foveaCount);

      // Build ring-compressed older context (progressively shorter excerpts)
      const rings = older.slice(0, 10).map((m, i) => { // max 10 compressed rings
        const budget  = Math.max(20, 100 - i * 10); // tighter budget per ring
        const excerpt = m.content.length > budget ? m.content.slice(0, budget) + '…' : m.content;
        return `[${_relativeAge(m.timestamp)} | ${m.role}] ${excerpt}`;
      });

      const verbatim = fovea.map(m => `[${m.role}]: ${m.content}`).join('\n');
      const compressed = rings.length ? '\n\n--- Compressed History ---\n' + rings.join('\n') : '';

      return {
        workspace: WORKSPACE,
        fovea_messages: fovea.length,
        compressed_rings: rings.length,
        summary: verbatim + compressed
      };
    }

    case 'memory_stats': {
      const total = await store.count();
      return { workspace: WORKSPACE, data_dir: DATA_DIR, total_messages: total };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _relativeAge(ts) {
  if (!ts) return 'unknown';
  const diffMs  = Date.now() - ts;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1)   return 'just now';
  if (diffMin < 60)  return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24)    return `${diffH}h ago`;
  return `${Math.floor(diffH / 24)}d ago`;
}

// ── JSON-RPC / MCP stdio transport ────────────────────────────────────────────
let buffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop(); // keep incomplete last line
  lines.forEach(line => {
    line = line.trim();
    if (line) handleMessage(line);
  });
});

async function handleMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); }
  catch { return; }

  const { id, method, params } = msg;

  // Notifications (no id) — ignore
  if (id === undefined && !method) return;

  try {
    const result = await dispatch(method, params || {});
    if (id !== undefined) send({ jsonrpc: '2.0', id, result });
  } catch (err) {
    if (id !== undefined) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: err.message } });
    }
  }
}

async function dispatch(method, params) {
  switch (method) {

    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
      };

    case 'notifications/initialized':
    case 'initialized':
      return {};

    case 'tools/list':
      return { tools: TOOLS };

    case 'tools/call': {
      const { name, arguments: args } = params;
      const content = await handleTool(name, args || {});
      return { content: [{ type: 'text', text: JSON.stringify(content, null, 2) }] };
    }

    case 'ping':
      return {};

    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// ── Boot ──────────────────────────────────────────────────────────────────────
process.stderr.write(`[foveated-memory MCP] started | workspace="${WORKSPACE}" | data="${DATA_DIR}"\n`);
