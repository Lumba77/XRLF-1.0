/**
 * ═══════════════════════════════════════════════════════
 * FOVEATED MEMORY PROXY — Main Server
 * ═══════════════════════════════════════════════════════
 *
 * OpenAI-compatible proxy server that gives any LLM infinite,
 * on-demand foveated memory using XRL Active Recall.
 *
 * Usage:
 *   node server.js [--config path/to/config.json]
 *   foveated-memory --upstream http://localhost:1234 --port 8200
 *
 * Point any OpenAI-compatible client at this server instead of
 * your LLM backend. Change one URL — every model gains memory.
 */

'use strict';

// ── Inline .env loader (no external dependency) ──────────────────────
// NSSM services don't auto-load .env files, so we do it manually.
// Loads ONLY the local .env in this directory — the xrlf-model proxy is
// fully self-contained and does NOT read from the parent XRLF .env.
(function loadEnv() {
    const fs = require('fs');
    const path = require('path');

    const localEnvPath = path.resolve(__dirname, '.env');
    try {
        const raw = fs.readFileSync(localEnvPath, 'utf8');
        for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx === -1) continue;
            const key = trimmed.slice(0, eqIdx).trim();
            const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
            if (!(key in process.env)) process.env[key] = val;
        }
        console.log('[XRLF] Loaded local .env configuration');
    } catch (e) { /* .env optional — silently ignore if missing */ }
})();

const express = require('express');
const http = require('http');
const fetch   = require('node-fetch');
const path    = require('path');
const fs      = require('fs');
const { execFile } = require('child_process');
const { v4: uuidv4 } = require('uuid');


// ============================================================
// REACTOR MASTER KILL SWITCH (Step 1)
// ============================================================
// XRLF_REPO_ENABLED=false -> the repo becomes COLD:
//   - no global caps
//   - no context override
//   - no foveation override
//   - no memory override
//   - no routing override
//   - no interference with your proxy / assistants
//
// Individual override isolators (Step 2A) can be toggled on top:
//   XRLF_CONTEXT_OVERRIDE, XRLF_CAPABILITY_OVERRIDE,
//   XRLF_FOVEATION_OVERRIDE
// Each defaults to the opposite of XRLF_REPO_ENABLED (i.e. disabled
// when the repo is cold), so the master switch fully isolates the repo.
const REPO_ENABLED = (() => {
    const v = (process.env.XRLF_REPO_ENABLED || "false").toLowerCase().trim();
    return v === "true" || v === "1" || v === "on";
})();
const REPO_CONTEXT_OVERRIDE = (() => {
    const v = (process.env.XRLF_CONTEXT_OVERRIDE || (REPO_ENABLED ? "true" : "false")).toLowerCase().trim();
    return v === "true" || v === "1" || v === "on";
})();
const REPO_CAPABILITY_OVERRIDE = (() => {
    const v = (process.env.XRLF_CAPABILITY_OVERRIDE || (REPO_ENABLED ? "true" : "false")).toLowerCase().trim();
    return v === "true" || v === "1" || v === "on";
})();
const REPO_FOVEATION_OVERRIDE = (() => {
    const v = (process.env.XRLF_FOVEATION_OVERRIDE || (REPO_ENABLED ? "true" : "false")).toLowerCase().trim();
    return v === "true" || v === "1" || v === "on";
})();

if (!REPO_ENABLED) {
    console.log("[XRLF] REACTOR COLD - repo overrides DISABLED (XRLF_REPO_ENABLED=false)");
    console.log("[XRLF]    context_override=" + REPO_CONTEXT_OVERRIDE + " capability_override=" + REPO_CAPABILITY_OVERRIDE + " foveation_override=" + REPO_FOVEATION_OVERRIDE);
} else {
    console.log("[XRLF] REACTOR HOT - repo overrides enabled (XRLF_REPO_ENABLED=true)");
    console.log("[XRLF]    context_override=" + REPO_CONTEXT_OVERRIDE + " capability_override=" + REPO_CAPABILITY_OVERRIDE + " foveation_override=" + REPO_FOVEATION_OVERRIDE);
}


// ── Diagnostic Logger ──────────────────────────────────────────────────────
const DIAG_LOG_FILE = path.join(__dirname, 'proxy_diagnostics.log');
function logDiagnostic(stage, data) {
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] [${stage}] ${JSON.stringify(data, null, 2)}\n---\n`;
    fs.appendFileSync(DIAG_LOG_FILE, entry, 'utf8');
}

const WT_EXE = process.env.WT_EXE_PATH || 'wt.exe';

// ── PowerShell Path Auto-Detection ─────────────────────────────────────────
// Resolves the best available PowerShell executable. Prefers PowerShell 7
// (pwsh.exe) if installed, otherwise falls back to the built-in Windows
// PowerShell (powershell.exe, always present on every Windows install).
// This prevents path errors when PowerShell 7 is not installed at the
// default location.
function resolvePwshPath() {
    const fs = require('fs');

    // 1. Explicit override via env var (if it exists on disk)
    if (process.env.PWSH_PATH && fs.existsSync(process.env.PWSH_PATH)) {
        return process.env.PWSH_PATH;
    }

    // 2. Common PowerShell 7 install locations
    const candidates = [
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
        process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Microsoft\\WindowsApps\\pwsh.exe` : null,
        process.env.ProgramFiles ? `${process.env.ProgramFiles}\\PowerShell\\7\\pwsh.exe` : null,
        process.env['ProgramFiles(x86)'] ? `${process.env['ProgramFiles(x86)']}\\PowerShell\\7\\pwsh.exe` : null
    ].filter(Boolean);

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    // 3. Try `where pwsh` on PATH
    try {
        const { execSync } = require('child_process');
        const result = execSync('where pwsh', { encoding: 'utf8', windowsHide: true }).trim();
        if (result) return result.split(/\r?\n/)[0];
    } catch (_) { /* not on PATH */ }

    // 4. Fallback: built-in Windows PowerShell (always available)
    return 'powershell.exe';
}

const PWSH = resolvePwshPath();
console.log(`[PWSH] Using PowerShell: ${PWSH}`);

const { MemoryStore }        = require('./memory/store');
const { buildRingBlock }     = require('./core/ring-builder');
const { patchMessages }      = require('./core/system-prompt-patch');
const { detectRecall, collectStream, collectJson, buildMemoryInjection }
                              = require('./core/recall-interceptor');
const { compressContext } = require('./core/context-compressor');
const { getAuthManager } = require('./core/auth-manager');
const { getSwarmRouter } = require('./core/swarm-router');
const { saveContinuity, loadContinuity, buildResumeContext, getHistory: getContinuityHistory, clearContinuity } = require('./core/memory-continuity');
const { checkQuality, quickCheck } = require('./core/quality-guard');
const { getBudget, getState: getHealerState, onSuccess, onFailure, applyBudget, injectWarning, resetBudget, setBudget } = require('./core/context-healer');
const { extractFromMessages, restoreToMessages, getStats: getPreserverStats, configure: configurePreserver } = require('./core/code-preserver');
const { saveShadowBlock, getShadowBlock, searchShadowBlocks, buildZoomInjection, getStats: getShadowStats } = require('./core/shadow-context');
const { detectSaccade, detectAccommodate, parseSaccadeTarget, parseAccommodate, validateSaccade, executeAccommodate, buildRestructuredFovea } = require('./core/saccade-engine');
const { classifyBatch, formatStats: formatRetinaStats, VALUE } = require('./core/retina');

// ── XRLF Unified Compression Utilities (self-contained, no external deps) ────────
const RE_THINKING = /<thinking>.*?<\/thinking>/gsi;
function stripThinking(content) {
    if (typeof content !== 'string') return content;
    return content.replace(RE_THINKING, '[thought]').trim();
}

// ── Multimodal Content Passthrough ──────────────────────────────────────────
function extractTextFromContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .filter(p => p && p.type === 'text' && typeof p.text === 'string')
        .map(p => p.text)
        .join('\n');
}

function isMultimodalContent(content) {
    return Array.isArray(content) && content.some(p => p && p.type === 'image_url');
}

function hasMultimodalMessages(messages) {
    return messages.some(m => isMultimodalContent(m.content));
}

// Fast dedup of repeated file reads inside a single request window.
function dedupeFileReads(messages) {
    const seen = new Set();
    return messages.map(m => {
        if (m.role !== 'user') return m;
        const textContent = extractTextFromContent(m.content);
        if (!textContent) return m;
        // Ultra-safe regex: no overlapping character classes, zero backtracking
        const fpMatch = textContent.match(/([A-Za-z]:[\\/][^\s,\u201c\u201d"']+|[a-zA-Z0-9_/-]+\.(?:py|ts|js|json|md|xml|kt|html|css)\b)/);
        const rangeMatch = textContent.match(/start_line[:\s=]+(\d+)(?:.{0,100}?)end_line[:\s=]+(\d+)/is)
            || textContent.match(/[Ll]ines?\s+(\d+)\s*[-\u2013to]+\s*(\d+)/);
        if (!fpMatch || !rangeMatch) return m;
        const key = `${fpMatch[1]}:${rangeMatch[1]}:${rangeMatch[2]}`;
        if (seen.has(key)) {
            const clone = { ...m, content: `[re-read] ${fpMatch[1]}:${rangeMatch[1]}-${rangeMatch[2]} - already seen, skipped` };
            return clone;
        }
        seen.add(key);
        return m;
    });
}

// Hard upstream token cap (port of XRLF_CLOUD_MAX_TOKENS_CAP from 8103 proxy)
// If env cap is set explicitly, use it; otherwise derive from model context window.
const CLOUD_MAX_TOKENS_CAP = parseInt(process.env.XRLF_CLOUD_MAX_TOKENS_CAP || '0', 10);
const PRESERVE_LAST_TURNS  = parseInt(process.env.XRLF_CLOUD_PRESERVE_LAST  || '10', 10);

// ── Context Window Spoofing ────────────────────────────────────────────────
// Reports a large context window to clients (Papillon, Cline, VS Code Copilot)
// while the proxy operates at a much smaller real window via XRL checkpointing.
// Set XRLF_SPOOF_CONTEXT_WINDOW=128000 to tell clients they have 128K available.
// Set XRLF_SAFE_MODE=true to disable spoofing and report real context windows.
const SPOOF_CONTEXT_WINDOW = parseInt(process.env.XRLF_SPOOF_CONTEXT_WINDOW || '0', 10);
const SAFE_MODE = process.env.XRLF_SAFE_MODE === 'true' || process.env.XRLF_SAFE_MODE === '1';

function getCloudCapForModel(modelName) {
    if (CLOUD_MAX_TOKENS_CAP > 0) return CLOUD_MAX_TOKENS_CAP;
    const ctx = detectContextWindow(modelName, 'cloud');
    if (ctx >= 500000) return 32768;   // 1M+ context window
    if (ctx >= 150000) return 16384;   // ~150K context window
    if (ctx >=  64000) return 12288;   // 64K-128K
    return 8192;                       // default
}

function enforceCloudBudget(messages, modelName = '') {
    if (COGNITIVE_MODE !== 'cloud') return messages;
    if (!REPO_ENABLED || !REPO_CONTEXT_OVERRIDE) return messages; // reactor cold: no global caps
    const cap = getCloudCapForModel(modelName);
    const budgetChars = cap * 3; // ~3 chars/token heuristic
    const totalChars  = messages.reduce((n, m) => n + (m.content?.length || 0), 0);
    if (totalChars <= budgetChars) return messages;

    const systemMsgs = messages.filter(m => m.role === 'system');
    const convoMsgs  = messages.filter(m => m.role !== 'system');
    const preserveFrom = Math.max(0, convoMsgs.length - PRESERVE_LAST_TURNS);
    const preservedConvo = convoMsgs.slice(preserveFrom);
    const systemChars = systemMsgs.reduce((n, m) => n + (m.content?.length || 0), 0);
    const budgetLeft  = budgetChars - systemChars;

    let trimmed = [...preservedConvo];
    while (trimmed.length > 0 && trimmed.reduce((n, m) => n + (m.content?.length || 0), 0) > budgetLeft) {
        trimmed.shift();
    }
    console.log(`[CloudBudget] trim ${totalChars} → ${systemChars + trimmed.reduce((n,m)=>n+(m.content?.length||0),0)} chars (cap ${cap} tok, preserve last ${PRESERVE_LAST_TURNS})`);
    return [...systemMsgs, ...trimmed];
}

// ── XRLF Native Skeletonizer (self-contained — no external CLI deps) ─────────────
// Extracts structural skeletons from source files natively in JS.
// Equivalent to TokenSlayer level 3: keeps imports, class/function signatures,
// strips bodies. Supports JS/TS/Python. Fallback: first N lines for other types.
function skeletonizeFile(filepath, level = 3) {
    try {
        if (!fs.existsSync(filepath)) return null;
        const src = fs.readFileSync(filepath, 'utf8');
        const ext = path.extname(filepath).toLowerCase();
        const lines = src.split('\n');
        if (level === 0) return src; // full file
        // Level 3 / deep: keep only imports and signatures
        const SIG_RE_JS = /^\s*(export\s+)?(async\s+)?function\s+\w+|^\s*(export\s+)?(class|const|let|var)\s+\w+|^\s*import\b|^\s*require\b|^\s*module\.exports/;
        const SIG_RE_PY = /^\s*(def |class |import |from |@)/;
        const isJs = ['.js', '.ts', '.jsx', '.tsx'].includes(ext);
        const isPy = ext === '.py';
        const sigRe = isJs ? SIG_RE_JS : (isPy ? SIG_RE_PY : null);
        if (!sigRe) return lines.slice(0, 80).join('\n') + '\n...(truncated)';
        const skeleton = lines.filter(l => sigRe.test(l) || l.trim() === '');
        return skeleton.join('\n') || src.slice(0, 2000);
    } catch (e) {
        console.warn('[XRLF-Skeletonizer] skeletonizeFile failed:', e.message);
        return null;
    }
}
function expandFileLine(filepath, lineNum, contextLines = 3) {
    try {
        if (!fs.existsSync(filepath)) return null;
        const lines = fs.readFileSync(filepath, 'utf8').split('\n');
        const start = Math.max(0, lineNum - contextLines - 1);
        const end   = Math.min(lines.length, lineNum + contextLines);
        return lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join('\n');
    } catch (e) {
        return null;
    }
}

// XRL-style atomic cache (tiny in-memory registry for expansion requests)
const xrlCache = new Map();
const XRL_NAMESPACE = 'XRLF';
function generateXrl(filepath, line, content) {
    const hash = require('crypto').createHash('sha256').update(`${filepath}:${line}:${content}`).digest('hex').slice(0, 6);
    const uri = `xrl://${XRL_NAMESPACE}/${filepath}:${line}:${hash}`;
    xrlCache.set(uri, { filepath, line, content, created: new Date().toISOString() });
    return uri;
}
function parseXrl(uri) {
    const m = uri.match(/^xrl:\/\/([^/]+)\/(.+):(\d+):([a-f0-9]{6})$/);
    return m ? { namespace: m[1], filepath: m[2], line: parseInt(m[3], 10), hash: m[4] } : null;
}

// Model context-window detection (ported from 8103)
function detectContextWindow(modelName, mode = 'cloud') {
    const m = (modelName || '').toLowerCase();
    if (m.includes('gemini-1.5') || m.includes('1m') || m.includes('2m') || m.includes('500k')) return 2000000;
    if (m.includes('gemini') || m.includes('128k')) return 128000;
    if (m.includes('gpt-4') || m.includes('claude-3') || m.includes('200k')) return 200000;
    if (m.includes('32k') || m.includes('64k') || m.includes('mixtral') || m.includes('command-r')) return 128000;
    if (m.includes('8k') || m.includes('16k') || m.includes('llama3') || m.includes('llama-3')) return 8192;
    if (m.includes('0.5b') || m.includes('1b') || m.includes('micro') || m.includes('tiny')) return 4096;
    return mode === 'cloud' ? 32768 : 8192;
}
function selectTier(ctx) {
    if (ctx >= 1000000) return 'micro';
    if (ctx >= 200000) return 'standard';
    if (ctx >= 32000)  return 'full';
    return 'standard';
}

// ── Config ─────────────────────────────────────────────────────────────────

function loadConfig(overrides = {}) {
    const defaultPath = path.join(__dirname, 'config', 'default.json');
    const defaults    = JSON.parse(fs.readFileSync(defaultPath, 'utf8'));

    // Check for a local config.json in cwd
    const localPath = path.join(process.cwd(), 'config.json');
    const local     = fs.existsSync(localPath)
        ? JSON.parse(fs.readFileSync(localPath, 'utf8'))
        : {};

    return { ...defaults, ...local, ...overrides };
}

const config = loadConfig();

// ── XRLF Port Override ─────────────────────────────────────────────────────
// The XRLF proxy runs on port 8202 by default (separate from the main proxy on 8200).
// Set XRLF_PROXY_PORT env var to override.
if (process.env.XRLF_PROXY_PORT) {
    config.proxy_port = parseInt(process.env.XRLF_PROXY_PORT, 10);
    console.log(`[XRLF] Port override: ${config.proxy_port}`);
}

// ── Cloud-Aware Upstream Routing ─────────────────────────────────────────────
// When XRLF_COGNITIVE_MODE=cloud, override upstream to Ollama Cloud with API key.
// Compression checkpoints (context-compressor.js) stay local on LM Studio — hybrid routing.
const COGNITIVE_MODE = (process.env.XRLF_COGNITIVE_MODE || 'local').toLowerCase();
const OLLAMA_CLOUD_URL = process.env.XRLF_PROXY_TARGET || 'https://ollama.com/v1';
const OLLAMA_API_KEY = process.env.XRLF_PROXY_API_KEY || process.env.OLLAMA_API_KEY || '';

// ── LM Studio Auto-Start (for local compression) ─────────────────────────────
// In cloud mode, chat completions go to Ollama Cloud, but compression checkpoints
// still use local LM Studio. If LM Studio is offline, auto-start it headlessly
// with the Qwen3.5-4B middleman model at 20% GPU offload.
const LM_STUDIO_URL = process.env.LM_STUDIO_URL || process.env.LOCAL_LLM_BASE || 'http://127.0.0.1:7272';
const MIDDLEMAN_MODEL = process.env.XRLF_MIDDLEMAN_MODEL || process.env.LOCAL_LLM_MODEL || 'qwen3.5-4b-abliterated';
const MIDDLEMAN_GPU_OFFLOAD = process.env.XRLF_MIDDLEMAN_GPU_OFFLOAD || '0.2';
const MIDDLEMAN_CONTEXT_LENGTH = process.env.XRLF_MIDDLEMAN_CONTEXT_LENGTH || '8192';

// ── Upstream Model Override ────────────────────────────────────────────────────
// The proxy receives `model: "auto"` from clients like Cline, which upstreams
// (LM Studio / Ollama Cloud) cannot resolve. Override with an explicit model name.
// Priority: XRLF_PROXY_MODEL env > MIDDLEMAN_MODEL (local) > hardcoded default.
// In cloud mode, the default is 'kimi-k2.7-code' (a confirmed available Ollama Cloud model).
// In local mode, the default is MIDDLEMAN_MODEL (the LM Studio loaded model).
const UPSTREAM_MODEL = process.env.XRLF_PROXY_MODEL || (COGNITIVE_MODE === 'cloud' ? (process.env.XRLF_MODEL_CLOUD_ID || 'kimi-k2.7-code') : (process.env.XRLF_MODEL_LOCAL_ID || process.env.LOCAL_LLM_MODEL || MIDDLEMAN_MODEL));

let _lmStudioStarting = false;

async function ensureLMStudio() {
    // Quick health check — is LM Studio already running?
    try {
        const r = await fetch(`${LM_STUDIO_URL}/v1/models`, { timeout: 2000 });
        if (r.ok) return true;
    } catch (_) { /* LM Studio offline — will auto-start below */ }

    // Prevent concurrent auto-start attempts
    if (_lmStudioStarting) return false;
    _lmStudioStarting = true;

    try {
        console.log('[AutoStart] LM Studio offline — starting headlessly...');

        // Step 1: Start LM Studio server
        await new Promise((resolve, reject) => {
            execFile('lms', ['server', 'start'], { timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
                if (err) { console.warn('[AutoStart] lms server start failed:', err.message); reject(err); }
                else { console.log('[AutoStart] lms server started'); resolve(); }
            });
        });

        // Step 2: Wait for server to be ready (poll up to 20s)
        let ready = false;
        for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 2000));
            try {
                const r = await fetch(`${LM_STUDIO_URL}/v1/models`, { timeout: 2000 });
                if (r.ok) { ready = true; break; }
            } catch (_) {}
        }
        if (!ready) { console.warn('[AutoStart] LM Studio server did not become ready in 20s'); return false; }

        // Step 3: Unload any existing models to free VRAM
        await new Promise((resolve) => {
            execFile('lms', ['unload', '--all'], { timeout: 15000, windowsHide: true }, (err) => {
                if (err) console.warn('[AutoStart] lms unload failed (non-critical):', err.message);
                resolve(); // non-critical — load will replace anyway
            });
        });

        // Step 4: Load the middleman model with GPU offload
        await new Promise((resolve, reject) => {
            const args = ['load', MIDDLEMAN_MODEL, '--gpu', MIDDLEMAN_GPU_OFFLOAD, '--context-length', MIDDLEMAN_CONTEXT_LENGTH, '-y'];
            execFile('lms', args, { timeout: 120000, windowsHide: true }, (err, stdout, stderr) => {
                if (err) { console.warn('[AutoStart] lms load failed:', err.message); reject(err); }
                else { console.log(`[AutoStart] LM Studio loaded model: ${MIDDLEMAN_MODEL}`); resolve(); }
            });
        });

        return true;
    } catch (e) {
        console.warn('[AutoStart] LM Studio auto-start failed:', e.message);
        return false;
    } finally {
        _lmStudioStarting = false;
    }
}

if (COGNITIVE_MODE === 'cloud') {
    config.upstream_url = OLLAMA_CLOUD_URL.replace(/\/v1\/?$/, '');
    config._cloud_mode = true;
    config._api_key = OLLAMA_API_KEY;
} else {
    config._cloud_mode = false;
    config._api_key = '';
}

const app    = express();

const DEBUG_LOG_PATH = path.join(__dirname, 'debug.log');
function logDebug(msg) {
    try {
        fs.appendFileSync(DEBUG_LOG_PATH, msg);
    } catch (e) {}
}

// Request logger (BEFORE body parsing!)
app.use((req, res, next) => {
    if (req.method !== 'OPTIONS') {
        console.log(`[Proxy] ${req.method} ${req.url}`);
        logDebug(`[${new Date().toISOString()}] Socket Hit: ${req.method} ${req.url}\n`);
    }
    next();
});

app.use(express.json({ limit: '50mb' }));

// Native CORS middleware
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// ── Dashboard static assets on port 8203 ─────────────────────────────────────
const DASHBOARD_PORT = parseInt(process.env.XRLF_DASHBOARD_PORT || '8203', 10);
const dashboardApp   = express();
dashboardApp.use(express.json());
const publicDir      = path.join(__dirname, 'public');
if (fs.existsSync(publicDir)) {
    dashboardApp.use('/', express.static(publicDir));
    dashboardApp.use('/memory', express.static(publicDir));
}
dashboardApp.get(['/', '/memory'], (req, res) => {
    const settingsPath = path.join(publicDir, 'settings.html');
    if (fs.existsSync(settingsPath)) return res.sendFile(settingsPath);
    const indexPath = path.join(publicDir, 'index.html');
    if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
    res.status(404).json({ error: 'Dashboard not installed.' });
});

// ── Active IDE Detection & Dispatch Endpoints ─────────────────────────────────
const IDE_PROCESS_MAP = [
    { id: 'antigravity', name: 'Antigravity / AGY', exePatterns: ['antigravity', 'agy', 'gemini-cli', 'antigravity-ide'], scheme: 'lx://chat?q=' },
    { id: 'vscode', name: 'VS Code', exePatterns: ['code', 'code - insiders'], scheme: 'vscode://chat?q=' },
    { id: 'cursor', name: 'Cursor', exePatterns: ['cursor'], scheme: 'cursor://chat?q=' },
    { id: 'windsurf', name: 'Windsurf', exePatterns: ['windsurf'], scheme: 'windsurf://chat?q=' },
    { id: 'hermes', name: 'Hermes Agent', exePatterns: ['hermes'], scheme: 'hermes://chat?q=' },
    { id: 'cline', name: 'Cline Agent', exePatterns: ['cline'], scheme: 'cline://chat?q=' },
    { id: 'codex', name: 'Codex / Custom', exePatterns: ['codex'], scheme: 'codex://chat?q=' }
];

function detectActiveIDEs(callback) {
    if (process.platform !== 'win32') {
        const fallback = { id: 'vscode', name: 'VS Code', scheme: 'vscode://chat?q=' };
        return callback(null, { detected: [fallback], primary: fallback, foreground: 'vscode' });
    }
    const psCmd = `$code = @"\nusing System;\nusing System.Runtime.InteropServices;\npublic class Win32 {\n  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();\n  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);\n}\n"@\nAdd-Type -TypeDefinition $code -ErrorAction SilentlyContinue\n$hwnd = [Win32]::GetForegroundWindow()\n$pid = 0\n[Win32]::GetWindowThreadProcessId($hwnd, [ref]$pid)\n$fgName = ""\nif ($pid -gt 0) { $fgName = (Get-Process -Id $pid -ErrorAction SilentlyContinue).ProcessName }\n$procs = (Get-CimInstance Win32_Process | Select-Object -ExpandProperty Name) -join "\n"\nWrite-Output "FG:$fgName"\nWrite-Output "PROCS:"\nWrite-Output $procs`;

    execFile(PWSH, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], { windowsHide: true }, (err, stdout) => {
        if (err || !stdout) {
            const fallback = { id: 'antigravity', name: 'Antigravity / AGY', scheme: 'lx://chat?q=' };
            return callback(null, { detected: [fallback], primary: fallback, foreground: 'antigravity' });
        }
        const lines = stdout.split(/\r?\n/);
        let fgName = '';
        const procs = [];
        let inProcs = false;
        for (const line of lines) {
            if (line.startsWith('FG:')) {
                fgName = line.slice(3).trim().toLowerCase();
            } else if (line.startsWith('PROCS:')) {
                inProcs = true;
            } else if (inProcs && line.trim()) {
                procs.push(line.trim().toLowerCase());
            }
        }

        const detected = [];
        let fgTarget = null;

        for (const target of IDE_PROCESS_MAP) {
            const isRunning = target.exePatterns.some(pattern => procs.some(p => p.includes(pattern)));
            if (isRunning) {
                detected.push(target);
            }
            if (fgName && target.exePatterns.some(pattern => fgName.includes(pattern))) {
                fgTarget = target;
            }
        }

        if (detected.length === 0) {
            detected.push({ id: 'antigravity', name: 'Antigravity / AGY', scheme: 'lx://chat?q=' });
        }

        const primary = fgTarget || detected[0];
        callback(null, { detected, primary, foreground: fgName || primary.id });
    });
}

const handleIdeDetect = (req, res) => {
    detectActiveIDEs((err, data) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(data);
    });
};

const handleXRLFDispatch = async (req, res) => {
    const { prompt } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    try {
        // Route directly through the main chat handler instead of looping back to the proxy port.
        const workspaceId = 'prompt_kiosk';
        const reqStore = getStore(workspaceId);
        const fakeReq = {
            body: {
                model: UPSTREAM_MODEL || 'foveated-proxy-auto',
                messages: [{ role: 'user', content: prompt }],
                stream: false
            },
            headers: { authorization: 'Bearer prompt_kiosk_agent' }
        };
        await handleChatCompletion(fakeReq, res, null, reqStore, workspaceId);
    } catch (err) {
        console.error('[XRLFDispatch] Error dispatching prompt to XRLF core:', err);
        if (!res.headersSent) res.status(500).json({ error: `Failed to dispatch prompt to FoveAI Agent: ${err.message}` });
    }
};

dashboardApp.get('/api/ide/detect', handleIdeDetect);
app.get('/api/ide/detect', handleIdeDetect);
dashboardApp.post('/api/XRLF/dispatch', handleXRLFDispatch);
app.post('/api/XRLF/dispatch', handleXRLFDispatch);

// Context Healer endpoints on dashboard port too
dashboardApp.get('/api/context/health', (req, res) => res.json(getHealerState()));
dashboardApp.post('/api/context/reset', (req, res) => {
    const result = resetBudget();
    res.json({ status: 'reset', ...result, state: getHealerState() });
});
dashboardApp.post('/api/context/budget', (req, res) => {
    const { budget } = req.body || {};
    if (!budget || typeof budget !== 'number') {
        return res.status(400).json({ error: 'budget (number) required' });
    }
    const result = setBudget(budget);
    res.json({ status: 'set', ...result, state: getHealerState() });
});

// ── Code Preserver API ──────────────────────────────────────────────────
dashboardApp.get('/api/preserver/stats', (req, res) => {
    res.json(getPreserverStats());
});
dashboardApp.post('/api/preserver/rule', (req, res) => {
    const { name, enabled } = req.body || {};
    if (!name || typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'name (string) and enabled (boolean) required' });
    }
    const { setRuleEnabled } = require('./core/code-preserver');
    setRuleEnabled(name, enabled);
    res.json({ status: 'ok', rule: name, enabled, stats: getPreserverStats() });
});
dashboardApp.post('/api/preserver/configure', (req, res) => {
    const { rules } = req.body || {};
    if (!Array.isArray(rules)) {
        return res.status(400).json({ error: 'rules (array) required' });
    }
    configurePreserver(rules);
    res.json({ status: 'ok', stats: getPreserverStats() });
});

// ── Shadow Context API ──────────────────────────────────────────────────
dashboardApp.get('/api/shadow/stats', (req, res) => {
    const sessionId = req.query.session || config.workspace_id;
    res.json(getShadowStats(sessionId));
});
dashboardApp.get('/api/shadow/search', (req, res) => {
    const sessionId = req.query.session || config.workspace_id;
    const q = req.query.q || '';
    if (!q) return res.status(400).json({ error: 'q (search query) required' });
    res.json(searchShadowBlocks(sessionId, q, 10));
});
dashboardApp.get('/api/shadow/block/:hash', (req, res) => {
    const sessionId = req.query.session || config.workspace_id;
    const block = getShadowBlock(sessionId, req.params.hash);
    if (!block) return res.status(404).json({ error: 'block not found' });
    res.json(block);
});

// ── Retina API ──────────────────────────────────────────────────────────
dashboardApp.post('/api/retina/classify', (req, res) => {
    const { messages } = req.body || {};
    if (!Array.isArray(messages)) {
        return res.status(400).json({ error: 'messages (array) required' });
    }
    const classification = classifyBatch(messages);
    res.json({
        stats: formatRetinaStats(classification.stats),
        shadow: classification.shadow.length,
        checkpoint: classification.checkpoint.length,
        ephemeral: classification.ephemeral.length,
        discard: classification.discard.length
    });
});

// ── Express Error Handler (catch body-parser errors, return JSON not HTML) ──
app.use((err, req, res, next) => {
    if (err && (err.type === 'entity.parse.failed' || err.message?.includes('raw-body') || err.message?.includes('stream') || err.code === 'HPE_INVALID_CONSTANT')) {
        console.error('[Express] Body parse error:', err.message);
        return res.status(400).json({
            error: {
                message: `Request body parse error: ${err.message}`,
                type: 'invalid_request_error',
                code: err.code || 'body_parse_error'
            }
        });
    }
    next(err);
});

// ── Memory Store Manager ────────────────────────────────────────────────────

const stores = new Map();

function getStore(workspaceId) {
    if (!stores.has(workspaceId)) {
        console.log(`[Store] Initializing new memory workspace: ${workspaceId}`);
        stores.set(workspaceId, new MemoryStore(
            path.resolve(config.persist_path),
            workspaceId
        ));
    }
    return stores.get(workspaceId);
}

// Pre-initialize the default store
getStore(config.workspace_id);

console.log(`\n🧠 Foveated Memory Proxy`);
console.log(`   Default Workspace : ${config.workspace_id} (${config.workspace_mode})`);
console.log(`   Upstream  : ${config.upstream_url}`);
console.log(`   Port      : ${config.proxy_port}`);
console.log(`   Mode      : ${COGNITIVE_MODE.toUpperCase()}${COGNITIVE_MODE === 'cloud' ? ' (Ollama Cloud)' : ' (LM Studio)'}`);
console.log(`   Compress  : LOCAL (LM Studio :7272) — zero cloud tokens for checkpoints`);
console.log(`   Healer    : Self-healing context guard (${getBudget()} chars, auto-shrink/restore)`);

// ── Session ID per connection ───────────────────────────────────────────────

// Simple: generate one session ID per server run.
// In a future phase: parse from request headers or JWT.
const SESSION_ID = uuidv4().slice(0, 8);

// ── Dynamic Resolution Scaling ────────────────────────────────────────────────
function scaleConfigForModel(modelName, baseConfig) {
    const model = (modelName || '').toLowerCase();
    let multiplier = 1.0;
    let label = "4K (Standard Fovea)";

    if (!REPO_ENABLED || !REPO_FOVEATION_OVERRIDE) {
        // Reactor cold or foveation override disabled — no scaling
        return { scaledConfig: JSON.parse(JSON.stringify(baseConfig)), label: "Passthrough (Reactor Cold)" };
    }

    if (model.includes('gemini-1.5') || model.includes('1m') || model.includes('2m') || model.includes('500k')) {
        multiplier = 25.0; // Huge 10k token memory block
        label = "1M+ (Panoramic Ultra-HD)";
    } else if (model.includes('gpt-4') || model.includes('claude-3') || model.includes('128k') || model.includes('200k')) {
        multiplier = 10.0; // 4000 token memory block
        label = "128K (Macula High-Res)";
    } else if (model.includes('32k') || model.includes('64k') || model.includes('mixtral') || model.includes('command-r')) {
        multiplier = 4.0; // 1600 token memory block
        label = "32K (Medium-Res)";
    } else if (model.includes('8k') || model.includes('16k') || model.includes('llama3') || model.includes('llama-3')) {
        multiplier = 2.0; // 800 token memory block
        label = "8K (Enhanced)";
    } else if (model.includes('0.5b') || model.includes('1b') || model.includes('micro') || model.includes('tiny') || model.includes('retina')) {
        // The "Retina" Micro-Res for ultra-small motherboard circuits
        multiplier = 0.32; // ~128 token memory block (hyper-dense receptors)
        label = "Micro (Dense Retina)";
    }

    // ── Manual Foveation Level Override (XRLF_PROXY_AGGRESSION) ──────────────
    // If XRLF_PROXY_AGGRESSION is set to 1-6, override the auto-detected multiplier
    // Level 0=Auto (model-detected), 1=Max Compression, 2=Standard, 3=Moderate, 4=Light, 5=Minimal, 6=Almost Raw
    const aggressionLevel = parseInt(process.env.XRLF_PROXY_AGGRESSION || '0', 10);
    const aggressionMap = { 1: 0.32, 2: 1.0, 3: 2.0, 4: 4.0, 5: 10.0, 6: 25.0 };
    const aggressionLabels = {
        1: "L1 Max Compression (x0.32)",
        2: "L2 Standard (x1.0)",
        3: "L3 Moderate (x2.0)",
        4: "L4 Light (x4.0)",
        5: "L5 Minimal (x10.0)",
        6: "L6 Almost Raw (x25.0)"
    };
    if (aggressionLevel >= 1 && aggressionLevel <= 6 && aggressionMap[aggressionLevel]) {
        multiplier = aggressionMap[aggressionLevel];
        label = aggressionLabels[aggressionLevel];
        console.log(`[Fovea] Manual override: XRLF_PROXY_AGGRESSION=${aggressionLevel} → multiplier=${multiplier} (${label})`);
    }

    // Deep copy base config
    const scaled = JSON.parse(JSON.stringify(baseConfig));
    scaled.ring_token_budget = Math.max(128, Math.floor(baseConfig.ring_token_budget * multiplier));

    // ── Cloud Fovea Budget Overrides ───────────────────────────────────────
    // Each fovea level can be overridden via .env (XRLF_FOVEA1_CLOUD_BUDGET, etc.)
    // Map multiplier → fovea level number for env var lookup
    const foveaLevelMap = { '0.32': 1, '1.0': 2, '2.0': 3, '4.0': 4, '10.0': 5, '25.0': 6 };
    const foveaLevel = foveaLevelMap[String(multiplier)];
    if (foveaLevel) {
        const envVarName = `XRLF_FOVEA${foveaLevel}_CLOUD_BUDGET`;
        const envBudgetOverride = parseInt(process.env[envVarName] || '0', 10);
        if (envBudgetOverride > 0) {
            scaled.ring_token_budget = envBudgetOverride;
        }
    }
    scaled.recall_max_results = Math.max(2, Math.floor(baseConfig.recall_max_results * multiplier));
    
    // Scale fovea messages (keep at least 2 for context)
    const fovMult = multiplier > 2 ? 2 : (multiplier < 1 ? 0.5 : 1.5);
    scaled.fovea_message_count = Math.max(2, Math.floor(baseConfig.fovea_message_count * fovMult));
    
    // Scale ring budgets proportionally
    for (const key in scaled.ring_budgets) {
        scaled.ring_budgets[key] = Math.max(10, Math.floor(baseConfig.ring_budgets[key] * multiplier));
    }
    
    return { scaledConfig: scaled, label };
}

// ── Core request handler ────────────────────────────────────────────────────

async function handleChatCompletion(req, res, injectMessages = null, store, workspaceId) {
    logDebug(`\n[${new Date().toISOString()}] handleChatCompletion started\n`);
    const body     = { ...req.body };
    const isStream = body.stream === true;

    // Dynamically scale memory resolution based on the requested model
    const { scaledConfig, label } = scaleConfigForModel(body.model, config);
    logDebug(`[${new Date().toISOString()}] scaleConfigForModel finished. Model=${body.model}\n`);
    if (!injectMessages) {
        console.log(`[Memory Resolution] Model '${body.model || 'unknown'}' mapped to ${label}. Budget: ${scaledConfig.ring_token_budget} tokens`);
    }

    const activeSessionId = req.body?.session_id || req.headers['x-session-id'] || (workspaceId + '_' + SESSION_ID);

    // Persist incoming tasks if provided by the client
    if (body._tasks) {
        try {
            await store.saveTasks(activeSessionId, body._tasks);
        } catch (e) {
            console.warn('[Tasks] Failed to save tasks:', e.message);
        }
    }

    // Build the foveated ring block for this session
    let ringBlock = '';
    try {
        logDebug(`[${new Date().toISOString()}] before buildRingBlock\n`);
        ringBlock = (REPO_ENABLED && REPO_FOVEATION_OVERRIDE) ? await buildRingBlock(store, scaledConfig, activeSessionId) : '';
        logDebug(`[${new Date().toISOString()}] after buildRingBlock\n`);
    } catch (e) {
        console.warn('[Rings] Failed to build ring block:', e.message);
    }

    // ── XRL Context Compression ──────────────────────────────────────────
    // Compress old turns into XRL checkpoints before patching (transparent)
    // In cloud mode, ensure LM Studio is running for local compression checkpoints
    // Fire-and-forget: don't block the request stream waiting for LM Studio startup
    if (COGNITIVE_MODE === 'cloud') {
        ensureLMStudio().catch(e => console.warn('[AutoStart] Background LM Studio check failed:', e.message));
    }

    const rawMessages   = injectMessages || body.messages || [];
    console.log(`[handleChatCompletion] ▶️ entry | inject=${!!injectMessages} | rawMessages=${rawMessages.length} | session=${activeSessionId}`);

    // ── Code Preservation: Extract protected structures BEFORE stripping ──
    // This ensures code fences, thinking blocks, JSON schemas, and tool
    // definitions survive the aggressive stripping/compression pipeline.
    const PRESERVE_CODE = REPO_ENABLED && REPO_CAPABILITY_OVERRIDE && process.env.XRLF_PRESERVE_CODE !== '0' && process.env.XRLF_PRESERVE_CODE !== 'false';
    let preservationStore = null;
    let preservedMessages = rawMessages;
    if (PRESERVE_CODE) {
        const result = extractFromMessages(rawMessages);
        preservationStore = result.store;
        console.log(`[CodePreserver] 🔒 Extracted ${preservationStore.size} protected blocks (${[...preservationStore.values()].reduce((n, e) => n + e.content.length, 0)} chars)`);
        preservedMessages = result.messages;
    }

    logDebug(`[${new Date().toISOString()}] before stripThinking and dedupeFileReads\n`);
    // XRLF-Skeletonizer pre-processing
    let processedMessages = preservedMessages.map(m => ({
        ...m,
        content: typeof m.content === 'string' ? stripThinking(m.content) : m.content
    }));
    processedMessages = dedupeFileReads(processedMessages);
    logDebug(`[${new Date().toISOString()}] after dedupeFileReads\n`);

    // Multimodal content detection
    if (hasMultimodalMessages(processedMessages)) {
        console.log('[Multimodal] 🖼️ Request contains image content — passthrough mode');
    }

    let baseMessages = processedMessages;
    const AUTO_CHECKPOINT = REPO_ENABLED && REPO_CONTEXT_OVERRIDE && process.env.XRLF_PROXY_AUTO_CHECKPOINT !== '0' && process.env.XRLF_PROXY_AUTO_CHECKPOINT !== 'false';
    const reqCompressLevel = req.headers['x-compression-level'] ? parseInt(req.headers['x-compression-level'], 10) : 3;

    // ── Shadow Context: Save full-fidelity blocks to disc BEFORE compression ──
    // The model can zoom back into these via <zoom: "hash"> at any time.
    // The retina classifier ensures only HIGH-value context gets shadow storage.
    // MEDIUM goes to XRL checkpoint, LOW stays ephemeral, ZERO is discarded.
    const SHADOW_ENABLED = REPO_ENABLED && REPO_FOVEATION_OVERRIDE && process.env.XRLF_SHADOW_CONTEXT !== '0' && process.env.XRLF_SHADOW_CONTEXT !== 'false';
    const RETINA_ENABLED = REPO_ENABLED && REPO_FOVEATION_OVERRIDE && process.env.XRLF_RETINA !== '0' && process.env.XRLF_RETINA !== 'false';
    let shadowRefs = [];
    let retinaStats = null;
    if (SHADOW_ENABLED) {
        try {
            const turnMsgs = processedMessages.filter(m => m.role !== 'system');

            if (RETINA_ENABLED) {
                // ── Retina: classify each message by value ──
                const classification = classifyBatch(turnMsgs);
                retinaStats = formatRetinaStats(classification.stats);
                console.log(`[Retina] 🧬 ${retinaStats.distribution.high} high | ${retinaStats.distribution.medium} med | ${retinaStats.distribution.low} low | ${retinaStats.distribution.zero} zero | ${retinaStats.savedPct}% chars saved by discarding zero-value`);

                // Only HIGH-value messages get shadow storage
                for (let i = 0; i < classification.shadow.length; i++) {
                    const msg = classification.shadow[i];
                    const ref = saveShadowBlock(activeSessionId, [msg], {
                        turnRange: [i + 1, i + 1],
                        value: VALUE.HIGH,
                        signals: msg._retina?.signals
                    });
                    if (ref) shadowRefs.push(ref);
                }
            } else {
                // Retina disabled — save all turn pairs (legacy behavior)
                for (let i = 0; i < turnMsgs.length; i += 2) {
                    const batch = turnMsgs.slice(i, i + 2);
                    if (batch.length > 0) {
                        const ref = saveShadowBlock(activeSessionId, batch, {
                            turnRange: [i + 1, i + batch.length]
                        });
                        if (ref) shadowRefs.push(ref);
                    }
                }
            }

            if (shadowRefs.length > 0) {
                console.log(`[ShadowContext] 💾 Saved ${shadowRefs.length} shadow blocks for session ${activeSessionId}`);
            }
        } catch (e) {
            console.warn('[ShadowContext] Save failed (non-critical):', e.message);
        }
    }

    if (AUTO_CHECKPOINT) {
        try {
            baseMessages = await compressContext(processedMessages, activeSessionId, reqCompressLevel);
        } catch (e) {
            console.warn('[Compress] compressContext failed, using raw messages:', e.message);
        }
    } else {
        console.log('[Compress] ⏭️ Auto-checkpointing disabled via .env');
    }

    // Final cloud budget safety trim (keeps last N turns protected)
    baseMessages = enforceCloudBudget(baseMessages, body.model || UPSTREAM_MODEL);

    // ── Smart Proxy Context Router ───────────────────────────────────────
    const SMART_PROXY_ENABLED = REPO_ENABLED && REPO_CONTEXT_OVERRIDE && process.env.XRLF_SMART_PROXY !== '0' && process.env.XRLF_SMART_PROXY !== 'false';
    if (SMART_PROXY_ENABLED) {
        try {
            const { smartRouteMessages } = require('./core/smart-router');
            const upstream = (config && config.upstream_url) ? config.upstream_url : 'http://127.0.0.1:7272';
            const middleman = (typeof MIDDLEMAN_MODEL !== 'undefined') ? MIDDLEMAN_MODEL : 'qwen2.5-0.5b-instruct';
            baseMessages = await smartRouteMessages(baseMessages, middleman, upstream);
        } catch (e) {
            console.warn('[Smart Router] smartRouteMessages failed, using unrouted messages:', e.message);
        }
    }

    console.log(`[handleChatCompletion] 📦 baseMessages=${baseMessages.length} (raw=${rawMessages.length})`);

    logDebug(`[${new Date().toISOString()}] before patchMessages\n`);
    // Patch messages with ring block + ACTIVE RECALL instructions
    body.messages = (REPO_ENABLED && REPO_CAPABILITY_OVERRIDE) ? patchMessages(baseMessages, ringBlock, scaledConfig, body) : baseMessages;
    logDebug(`[${new Date().toISOString()}] after patchMessages\n`);

    // ── Self-Healing Context Guard ────────────────────────────────────────
    // Auto-scaling context budget that shrinks on upstream failure and
    // gradually recovers. Replaces the old static CTX_MAX_CHARS truncation.
    const CTX_KEEP_LAST = parseInt(process.env.XRLF_CTX_KEEP_LAST || '6', 10);
    const budgetResult = (REPO_ENABLED && REPO_CONTEXT_OVERRIDE) ? applyBudget(body.messages, CTX_KEEP_LAST) : { messages: body.messages, truncated: false, originalChars: 0, finalChars: 0, warning: '' };
    const { messages: budgetedMessages, truncated, originalChars, finalChars, warning } = budgetResult;
    body.messages = budgetedMessages;

    // ── Code Preservation: Restore protected structures AFTER pipeline ──
    // Swap [PRESERVED:hash:type] tokens back to original code blocks.
    if (PRESERVE_CODE && preservationStore && preservationStore.size > 0) {
        body.messages = restoreToMessages(body.messages, preservationStore);
        console.log(`[CodePreserver] 🔓 Restored ${preservationStore.size} protected blocks into final messages`);
    }
    if (truncated) {
        console.warn(`[ContextHealer] ⚠️ Budget applied: ${originalChars} → ${finalChars} chars. Budget=${getBudget()}. Warning: ${warning}`);
    }

    // Preserve client's original stream preference
    body.stream = isStream;

    // ── Model Resolution ──────────────────────────────────────────────────────
    const originalModel = body.model || '';
    const isLocalLMStudio = config.upstream_url.includes('127.0.0.1') || config.upstream_url.includes('localhost');
    
    // In cloud mode, pass through the client's model name — don't override it.
    // Only override when: (a) local LM Studio needs a specific model, or (b) model is 'auto'/empty.
    const shouldOverride = (isLocalLMStudio && COGNITIVE_MODE !== 'cloud') || originalModel === 'auto' || !originalModel;
    const currentEnvModel = COGNITIVE_MODE === 'cloud'
        ? (process.env.XRLF_MODEL_CLOUD_ID || process.env.XRLF_PROXY_MODEL || UPSTREAM_MODEL).trim()
        : (process.env.XRLF_MODEL_LOCAL_ID || process.env.XRLF_PROXY_MODEL || UPSTREAM_MODEL).trim();
    if (shouldOverride) {
        body.model = currentEnvModel;
        console.log(`[Model] Resolved '${originalModel}' → '${body.model}' (Env target: ${currentEnvModel})`);
    } else {
        console.log(`[Model] Passthrough model: '${body.model}' (no override). Cognitive mode: ${COGNITIVE_MODE}`);
    }

    // ── Self-Healing Upstream Fetch (with retry loop) ────────────────────
    const MAX_CTX_RETRIES = parseInt(process.env.XRLF_CTX_MAX_RETRIES || '3', 10);
    let upstreamRes;
    let retryCount = 0;
    let lastErrorText = '';
    let lastErrorStatus = 0;
    
    while (retryCount <= MAX_CTX_RETRIES) {
        try {
            const upstreamHeaders = { 'Content-Type': 'application/json' };
            if (config._cloud_mode && config._api_key) {
                upstreamHeaders['Authorization'] = `Bearer ${config._api_key}`;
            }
            
            // P2P Swarm Routing: Determine best available local node based on capability
            const swarmRouter = getSwarmRouter(path.resolve(__dirname, 'memory_data'));
            const requiredCapability = swarmRouter.detectCapability(body.messages);
            let targetUpstream = config.upstream_url;
            
            // Only use Swarm Router in local Cognitive Mode and when repo context override is enabled
            if (COGNITIVE_MODE !== 'cloud' && REPO_ENABLED && REPO_CONTEXT_OVERRIDE) {
                const bestNode = swarmRouter.route(requiredCapability);
                if (bestNode) {
                    targetUpstream = bestNode;
                    logDebug(`[SwarmRouter] Routing task (capability: ${requiredCapability}) to ${targetUpstream}`);
                }
            }
            
            // Ensure upstream URL doesn't have double /v1 if node already has it
            let fetchUrl = `${targetUpstream}/v1/chat/completions`;
            if (targetUpstream.endsWith('/v1')) fetchUrl = `${targetUpstream}/chat/completions`;

            logDebug(`[${new Date().toISOString()}] before fetch to ${fetchUrl} (attempt ${retryCount + 1}/${MAX_CTX_RETRIES + 1})\n`);
            upstreamRes = await fetch(fetchUrl, {
                method: 'POST',
                headers: upstreamHeaders,
                body: JSON.stringify(body)
            });
            logDebug(`[${new Date().toISOString()}] after fetch to upstream\n`);
            
            // Success — notify healer
            if (upstreamRes.ok) {
                onSuccess();
                break; // exit retry loop
            }
            
            // Non-OK response — collect error text
            lastErrorText = await upstreamRes.text();
            lastErrorStatus = upstreamRes.status;
            console.error(`[Proxy] Upstream returned ${upstreamRes.status}: ${lastErrorText.slice(0, 500)}`);
            
            // Diagnose: is this a context overflow?
            const { shrunk, shouldRetry, reason } = onFailure(upstreamRes.status, lastErrorText, '');
            
            if (shrunk && shouldRetry && retryCount < MAX_CTX_RETRIES) {
                // Re-apply budget with the new (smaller) limit
                const { messages: retryMessages, warning: retryWarning } = applyBudget(body.messages, CTX_KEEP_LAST);
                body.messages = retryMessages;
                retryCount++;
                console.log(`[ContextHealer] 🔄 Retry ${retryCount}/${MAX_CTX_RETRIES} with budget=${getBudget()} chars (reason: ${reason})`);
                continue; // retry
            }
            
            // Can't retry — return error as valid JSON with choices
            console.error(`[ContextHealer] ❌ Giving up after ${retryCount} retries. Budget=${getBudget()}.`);
            return res.status(upstreamRes.status).json({
                id: `chatcmpl-${uuidv4().slice(0, 8)}`,
                object: 'chat.completion',
                model: body.model || 'foveated-proxy',
                choices: [{
                    message: {
                        role: 'assistant',
                        content: `⚠️ Context overflow: The upstream model could not process this request even after auto-shrinking the context to ${getBudget()} chars. Please reduce the input size or increase XRLF_CTX_MAX_CHARS. (Upstream: ${upstreamRes.status})`
                    },
                    index: 0,
                    finish_reason: 'error'
                }],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                _healer: { budget: getBudget(), retries: retryCount, reason }
            });
            
        } catch (err) {
            console.error('[Proxy] Upstream connection failed:', err.message);
            lastErrorText = err.message;
            lastErrorStatus = 0;
            
            const { shrunk, shouldRetry, reason } = onFailure(0, err.message, '');
            
            if (shrunk && shouldRetry && retryCount < MAX_CTX_RETRIES) {
                const { messages: retryMessages } = applyBudget(body.messages, CTX_KEEP_LAST);
                body.messages = retryMessages;
                retryCount++;
                console.log(`[ContextHealer] 🔄 Retry ${retryCount}/${MAX_CTX_RETRIES} after connection error (budget=${getBudget()})`);
                continue;
            }
            
            return res.status(502).json({
                id: `chatcmpl-${uuidv4().slice(0, 8)}`,
                object: 'chat.completion',
                model: body.model || 'foveated-proxy',
                choices: [{
                    message: {
                        role: 'assistant',
                        content: `⚠️ Upstream LLM unreachable: ${err.message}. Context budget auto-adjusted to ${getBudget()} chars.`
                    },
                    index: 0,
                    finish_reason: 'error'
                }],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                _healer: { budget: getBudget(), retries: retryCount, reason }
            });
        }
    }

    // ── Passthrough Mode (real-time streaming for IDE plugins — zero freezing) ──────────
    const PASSTHROUGH_MODE = process.env.FOVEA_PASSTHROUGH_MODE !== 'false';
    if (PASSTHROUGH_MODE && isStream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        
        let buffer = '';
        let thinkingStarted = false;
        let thinkingEnded = false;
        let firstChunkSent = false;

        upstreamRes.body.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data:')) {
                    res.write(line + '\n');
                    continue;
                }
                const dataStr = line.slice(5).trim();
                if (dataStr === '[DONE]') {
                    if (thinkingStarted && !thinkingEnded) {
                        res.write('data: ' + JSON.stringify({choices:[{delta:{content:'\\n</think>\\n\\n'}}]}) + '\n\n');
                    }
                    res.write('data: [DONE]\n\n');
                    continue;
                }
                try {
                    const parsed = JSON.parse(dataStr);
                    const delta = parsed?.choices?.[0]?.delta;
                    
                    if (delta) {
                        if (!firstChunkSent) {
                            delta.role = 'assistant';
                            firstChunkSent = true;
                        }

                        // Ollama Cloud returns reasoning in `delta.reasoning`; treat it like `reasoning_content`
                        const reasoningText = delta.reasoning_content || delta.reasoning || '';
                        if (reasoningText) {
                            if (!thinkingStarted) {
                                thinkingStarted = true;
                                delta.content = '\n<thinking>\n' + reasoningText;
                            } else {
                                delta.content = reasoningText;
                            }
                            delete delta.reasoning_content;
                            delete delta.reasoning;
                        } else if (delta.content) {
                            if (thinkingStarted && !thinkingEnded) {
                                thinkingEnded = true;
                                delta.content = '\n</thinking>\n\n' + delta.content;
                            }
                        }
                        res.write(`data: ${JSON.stringify(parsed)}\n\n`);
                    } else {
                        res.write(line + '\n');
                    }
                } catch (e) {
                    res.write(line + '\n');
                }
            }
        });

        upstreamRes.body.on('end', () => {
            if (buffer) {
                if (buffer.startsWith('data: ') && thinkingStarted && !thinkingEnded && buffer.includes('[DONE]')) {
                    res.write('data: ' + JSON.stringify({choices:[{delta:{content:'\\n</think>\\n\\n'}}]}) + '\n\n');
                }
                res.write(buffer);
            }
            res.end();
        });
        upstreamRes.body.on('error', (e) => {
            console.error('[Passthrough] Stream error:', e);
            res.end();
        });
        return;
    }

    // Collect the response watching for <recall:>, <zoom:>, <saccade:>, <accommodate:> tokens
    let fullText, recallQuery, zoomQuery, saccadeQuery, accommodateQuery, rawJsonData;
    if (isStream) {
        const streamResult = await collectStream(upstreamRes);
        fullText = streamResult.fullText;
        recallQuery = streamResult.recallQuery;
        zoomQuery = streamResult.zoomQuery;
        saccadeQuery = streamResult.saccadeQuery;
        accommodateQuery = streamResult.accommodateQuery;
    } else {
        const jsonResult = await collectJson(upstreamRes);
        fullText = jsonResult.fullText;
        recallQuery = jsonResult.recallQuery;
        zoomQuery = jsonResult.zoomQuery;
        saccadeQuery = jsonResult.saccadeQuery;
        accommodateQuery = jsonResult.accommodateQuery;
        rawJsonData = jsonResult.data;
    }

    if (!fullText && !recallQuery && !zoomQuery && !saccadeQuery && !accommodateQuery) {
        console.warn('[handleChatCompletion] ⚠️ collect stream/json returned empty fullText — upstream likely OOM/crashed');
        
        // Notify healer of empty response (likely context overflow)
        const { shrunk, reason } = onFailure(200, '', '');
        
        const healerState = getHealerState();
        const warningMsg = shrunk
            ? `⚠️ The upstream model returned an empty response (likely context overflow). Context budget auto-shrunk to ${healerState.currentBudget} chars. It will auto-restore after stable operation.`
            : `⚠️ The upstream model returned an empty response. This may be a context overflow. Current budget: ${healerState.currentBudget} chars.`;
        
        // Return a valid response instead of empty content that causes VS Code "no choices" error
        if (isStream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            const id = `chatcmpl-${uuidv4().slice(0, 8)}`;
            res.write(`data: ${JSON.stringify({id, object:'chat.completion.chunk', choices:[{delta:{role:'assistant',content: warningMsg}}]})}\n\n`);
            res.write(`data: ${JSON.stringify({id, object:'chat.completion.chunk', choices:[{delta:{},finish_reason:'stop'}]})}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        } else {
            res.json({
                id: `chatcmpl-${uuidv4().slice(0, 8)}`,
                object: 'chat.completion',
                model: body.model || 'foveated-proxy',
                choices: [{
                    message: { role: 'assistant', content: warningMsg },
                    index: 0,
                    finish_reason: 'stop'
                }],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                _healer: healerState
            });
        }
        return;
    }

    // ── Recall detected ─────────────────────────────────────────────────────
    if (recallQuery) {
        console.log(`\n🔍 [Recall] Query: "${recallQuery}" | baseMessages=${baseMessages.length} | fullText=${fullText.length} chars`);

        // Search memory store
        const results = await store.search(recallQuery, config.recall_max_results || 5);
        console.log(`   Found ${results.length} matching memories.`);

        // Build the injection block
        const memoryInjection = buildMemoryInjection(recallQuery, results);
        console.log(`   Injecting: ${memoryInjection.slice(0, 80)}…`);

        // Add to conversation: assistant partial thought + memory + continuation
        const continuationMessages = [
            ...baseMessages,
            { role: 'assistant', content: fullText },
            { role: 'system',    content: memoryInjection },
            { role: 'user',      content: config.continuation_prompt }
        ];

        // Recursively handle (the continuation will NOT have a recall)
        console.log(`[handleChatCompletion] 🔄 recursive recall | continuationMessages=${continuationMessages.length}`);
        return handleChatCompletion(req, res, continuationMessages, store, workspaceId);
    }

    // ── Zoom detected — model wants full-fidelity shadow context ──────────
    if (zoomQuery) {
        console.log(`\n🔍 [Zoom] Query: "${zoomQuery}" | session=${activeSessionId} | fullText=${fullText.length} chars`);

        let zoomInjection = null;

        // Check if it's a hash (10 hex chars) or a search phrase
        if (/^[a-f0-9]{10}$/.test(zoomQuery)) {
            // Direct hash lookup — fastest path
            const block = getShadowBlock(activeSessionId, zoomQuery);
            if (block) {
                zoomInjection = buildZoomInjection(block);
                console.log(`[Zoom] ✅ Direct hash hit: ${zoomQuery} (${block.charCount} chars restored)`);
            }
        } else {
            // Search phrase — find best matching shadow blocks
            const results = searchShadowBlocks(activeSessionId, zoomQuery, 3);
            if (results.length > 0) {
                // Inject the top match at full fidelity
                const block = getShadowBlock(activeSessionId, results[0].hash);
                if (block) {
                    zoomInjection = buildZoomInjection(block);
                    console.log(`[Zoom] ✅ Search hit: "${zoomQuery}" → ${results[0].hash} (score ${results[0].score}, ${block.charCount} chars)`);
                }
            }
        }

        if (!zoomInjection) {
            zoomInjection = {
                role: 'system',
                content: `[SHADOW ZOOM — no match for "${zoomQuery}"]. No shadow context found. Continue with current context.`
            };
            console.log(`[Zoom] ❌ No match for: "${zoomQuery}"`);
        }

        // Add to conversation: assistant partial thought + zoomed context + continuation
        const continuationMessages = [
            ...baseMessages,
            { role: 'assistant', content: fullText },
            zoomInjection,
            { role: 'user', content: '[SYSTEM: Shadow context restored at full fidelity. Please continue your response using this zoomed-in context.]' }
        ];

        console.log(`[handleChatCompletion] 🔄 recursive zoom | continuationMessages=${continuationMessages.length}`);
        return handleChatCompletion(req, res, continuationMessages, store, workspaceId);
    }

    // ── Saccade detected — model wants to move the fovea ─────────────────
    if (saccadeQuery) {
        console.log(`\n👁️ [Saccade] Target: "${saccadeQuery}" | session=${activeSessionId} | fullText=${fullText.length} chars`);

        const parsed = parseSaccadeTarget(saccadeQuery);
        const SACCADE_TOKEN_BUDGET = parseInt(process.env.XRLF_SACCADE_TOKEN_BUDGET || '2000', 10);
        const validation = validateSaccade(activeSessionId, parsed, baseMessages, SACCADE_TOKEN_BUDGET);

        if (!validation.valid) {
            console.warn(`[Saccade] ❌ Rejected: ${validation.reason}`);
            const rejectionMessages = [
                ...baseMessages,
                { role: 'assistant', content: fullText },
                { role: 'system', content: `[SACCADE REJECTED — ${validation.reason}]. The fovea stays at current position. Continue with available context or try a different target.]` },
                { role: 'user', content: '[SYSTEM: Saccade rejected. Please continue your response with the current context.]' }
            ];
            return handleChatCompletion(req, res, rejectionMessages, store, workspaceId);
        }

        // "newest" saccade = return to recent context (no blocks to inject)
        if (parsed.type === 'newest') {
            console.log(`[Saccade] ✅ Returning fovea to recent context`);
            const returnMessages = [
                ...baseMessages,
                { role: 'assistant', content: fullText },
                { role: 'system', content: `[SACCADE — fovea returned to recent context. Recent turns are now at full fidelity again.]` },
                { role: 'user', content: '[SYSTEM: Fovea returned to recent context. Please continue your response.]' }
            ];
            return handleChatCompletion(req, res, returnMessages, store, workspaceId);
        }

        // Valid saccade — restructure the fovea
        const saccadeBlocks = validation.blocks || (validation.block ? [validation.block] : []);
        if (saccadeBlocks.length === 0) {
            console.warn(`[Saccade] ❌ No blocks retrieved despite validation pass`);
            const noBlockMessages = [
                ...baseMessages,
                { role: 'assistant', content: fullText },
                { role: 'system', content: `[SACCADE — no shadow blocks found for "${saccadeQuery}"]. Continue with current context.]` },
                { role: 'user', content: '[SYSTEM: No shadow context found. Please continue.]' }
            ];
            return handleChatCompletion(req, res, noBlockMessages, store, workspaceId);
        }

        const restructuredMessages = buildRestructuredFovea(baseMessages, saccadeBlocks, validation.reason);
        console.log(`[Saccade] ✅ Fovea shifted: ${validation.reason} | restructuredMessages=${restructuredMessages.length}`);
        return handleChatCompletion(req, res, restructuredMessages, store, workspaceId);
    }

    // ── Accommodate detected — model wants to sharpen/blur a region ───────
    if (accommodateQuery) {
        console.log(`\n🔬 [Accommodate] Directive: "${accommodateQuery}" | session=${activeSessionId} | fullText=${fullText.length} chars`);

        const parsed = parseAccommodate(accommodateQuery);
        const ACCOMMODATE_TOKEN_BUDGET = parseInt(process.env.XRLF_SACCADE_TOKEN_BUDGET || '2000', 10);
        const result = executeAccommodate(activeSessionId, parsed, baseMessages, ACCOMMODATE_TOKEN_BUDGET);

        if (!result.valid || !result.injection) {
            console.warn(`[Accommodate] ❌ Rejected: ${result.reason}`);
            const rejectionMessages = [
                ...baseMessages,
                { role: 'assistant', content: fullText },
                { role: 'system', content: `[ACCOMMODATION REJECTED — ${result.reason}]. Continue with current context.]` },
                { role: 'user', content: '[SYSTEM: Accommodation rejected. Please continue your response.]' }
            ];
            return handleChatCompletion(req, res, rejectionMessages, store, workspaceId);
        }

        const continuationMessages = [
            ...baseMessages,
            { role: 'assistant', content: fullText },
            result.injection,
            { role: 'user', content: '[SYSTEM: Accommodation applied. Please continue your response with the adjusted context fidelity.]' }
        ];
        console.log(`[Accommodate] ✅ ${result.reason} | continuationMessages=${continuationMessages.length}`);
        return handleChatCompletion(req, res, continuationMessages, store, workspaceId);
    }

    // ── No recall/zoom/saccade/accommodate — store this turn and return ──

    // Store the last user message under the activeSessionId
    const lastUser = [...(baseMessages)].reverse().find(m => m.role === 'user');
    if (lastUser) {
        await store.store(activeSessionId, 'user', lastUser.content, new Date().toISOString(), req.userId);
    }

    // Store assistant response under the activeSessionId
    if (fullText) {
        await store.store(activeSessionId, 'assistant', fullText, new Date().toISOString(), 'assistant');

        // ── Memory Continuity: save ring state after each turn ──────────
        try {
            const continuityState = {
                sessionId: activeSessionId,
                workspaceId,
                model: body.model || 'foveated-proxy',
                lastUserMessage: lastUser ? (typeof lastUser.content === 'string' ? lastUser.content : extractTextFromContent(lastUser.content)) : '',
                lastAssistantMessage: fullText,
                timestamp: new Date().toISOString(),
                ringState: store.getRingState ? store.getRingState() : null,
                messageCount: store.getMessageCount ? await store.getMessageCount(activeSessionId) : 0
            };
            saveContinuity(continuityState);
        } catch (e) {
            console.warn('[Continuity] Failed to save continuity state:', e.message);
        }

        // ── Quality Guard: check response quality ──────────────────────
        const qualityResult = quickCheck(fullText);
        if (!qualityResult.passed) {
            console.warn(`[QualityGuard] ⚠️ Response flagged: score=${qualityResult.qualityScore} issues=${qualityResult.issues.join(',')}`);
        }

        // Fire-and-forget speech dispatch to Mouth TTS service (port 8004 / 8001) for 3D avatar audio sync
        const mouthUrl = process.env.MOUTH_URL || 'http://127.0.0.1:8004';
        try {
            const cleanSpeech = fullText.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```[\s\S]*?```/g, '').replace(/[*_#`]/g, '').trim();
            if (cleanSpeech.length > 0 && cleanSpeech.length < 400) {
                fetch(`${mouthUrl}/say`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: cleanSpeech, voice: process.env.XRLF_KOKORO_VOICE || 'af_heart' }),
                    signal: AbortSignal.timeout(4000)
                }).catch(() => {});
            }
        } catch (_) {}
    }

    // Return to client in the requested format
    if (isStream) {
        // Re-emit as SSE
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const id = `chatcmpl-${uuidv4().slice(0, 8)}`;
        // Stream word-by-word for natural feel
        const words = fullText.split(' ');
        for (let i = 0; i < words.length; i++) {
            const token = (i === 0 ? '' : ' ') + words[i];
            const chunk = {
                id,
                object: 'chat.completion.chunk',
                choices: [{ delta: { content: token }, index: 0, finish_reason: null }]
            };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        // Final chunk
        const finalChunk = {
            id, object: 'chat.completion.chunk',
            choices: [{ delta: {}, index: 0, finish_reason: 'stop' }]
        };
        res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
    } else {
        // Inject context warning if budget was shrunk
        const healerState = getHealerState();
        const responseContent = healerState.totalShrinks > 0 && healerState.currentBudget < healerState.maxBudget
            ? injectWarning(fullText, `Context budget currently at ${healerState.currentBudget}/${healerState.maxBudget} chars (auto-shrunk ${healerState.totalShrinks}x). Will auto-restore.`)
            : fullText;
        
        // Return as normal JSON response
        res.json({
            id: `chatcmpl-${uuidv4().slice(0, 8)}`,
            object: 'chat.completion',
            model: body.model || 'foveated-proxy',
            choices: [{
                message: { role: 'assistant', content: responseContent },
                index: 0,
                finish_reason: 'stop'
            }],
            usage: {
                prompt_tokens: Math.ceil(JSON.stringify(body.messages).length / 4),
                completion_tokens: Math.ceil(fullText.length / 4),
                total_tokens: Math.ceil((JSON.stringify(body.messages).length + fullText.length) / 4)
            },
            _healer: healerState
        });
    }
}

// ── API endpoints (compatible with both old 8103 and 8200 paths) ─────────────

// ── Context Healer Health & Control API ────────────────────────────────────
app.get('/_health/context', (req, res) => {
    res.json(getHealerState());
});

app.post('/_health/context/reset', (req, res) => {
    const result = resetBudget();
    res.json({ status: 'reset', ...result, state: getHealerState() });
});

app.post('/_health/context/budget', (req, res) => {
    const { budget } = req.body || {};
    if (!budget || typeof budget !== 'number') {
        return res.status(400).json({ error: 'budget (number) required' });
    }
    const result = setBudget(budget);
    res.json({ status: 'set', ...result, state: getHealerState() });
});

// ── Memory Continuity API ──────────────────────────────────────────────────
app.get('/v1/memory/continuity', (req, res) => {
    try {
        const snapshot = loadContinuity();
        res.json({ snapshot, resumeContext: snapshot ? buildResumeContext(snapshot) : null });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/v1/memory/continuity', (req, res) => {
    try {
        const state = req.body;
        saveContinuity(state);
        res.json({ status: 'saved', timestamp: new Date().toISOString() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/v1/memory/continuity/history', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const history = getContinuityHistory(limit);
        res.json({ history, count: history.length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/v1/memory/continuity', (req, res) => {
    try {
        clearContinuity();
        res.json({ status: 'cleared' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Semantic Memory Search API ──────────────────────────────────────────────
function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}

app.post('/v1/memory/search', async (req, res) => {
    try {
        const { query, limit = 10, mode = 'tfidf', sessionId } = req.body;
        if (!query) return res.status(400).json({ error: 'query required' });

        const store = getStore(config.workspace_id);
        const results = await store.search(query, limit, sessionId);

        // If embedding mode requested, try LM Studio embeddings
        if (mode === 'embedding' && results.length > 0) {
            try {
                const embResp = await fetch(`${config.upstream_url}/v1/embeddings`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ input: [query, ...results.map(r => r.content)].filter(Boolean) }),
                    signal: AbortSignal.timeout(10000)
                });
                if (embResp.ok) {
                    const embData = await embResp.json();
                    const embeddings = embData.data || [];
                    const queryEmb = embeddings[0]?.embedding;
                    if (queryEmb) {
                        results.forEach((r, i) => {
                            const docEmb = embeddings[i + 1]?.embedding;
                            r._embeddingScore = docEmb ? cosineSimilarity(queryEmb, docEmb) : 0;
                        });
                        results.sort((a, b) => (b._embeddingScore || 0) - (a._embeddingScore || 0));
                    }
                }
            } catch (e) {
                console.warn('[SemanticSearch] Embedding mode failed, falling back to TF-IDF:', e.message);
            }
        }

        res.json({ results, count: results.length, mode });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── XRLF Format Inspector ──────────────────────────────────────────────────
app.get('/api/xrlf/inspect', (req, res) => {
    res.json({
        capabilities: {
            compression: true,
            rings: ['Fovea (0)', 'Parafovea (1)', 'Near Periphery (2)', 'Mid Periphery (3)', 'Far Periphery (4)', 'Outer Periphery (5)'],
            checkpointing: true,
            recall: true,
            continuity: true,
            qualityGuard: true,
            multimodal: true,
            semanticSearch: true
        },
        version: '3.0.0',
        service: 'FoveatedMemory XRLF Proxy'
    });
});

app.post('/api/xrlf/inspect', async (req, res) => {
    try {
        const { sessionId } = req.body;
        const store = getStore(config.workspace_id);
        const ringState = store.getRingState ? store.getRingState() : null;
        const messageCount = sessionId ? (store.getMessageCount ? await store.getMessageCount(sessionId) : 0) : 0;
        const continuity = loadContinuity();

        res.json({
            ringState,
            messageCount,
            sessionId: sessionId || 'default',
            continuity: continuity ? {
                lastSessionId: continuity.sessionId,
                lastTimestamp: continuity.timestamp,
                messageCount: continuity.messageCount
            } : null,
            timestamp: new Date().toISOString()
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Quality Check API ──────────────────────────────────────────────────────
app.post('/api/quality/check', (req, res) => {
    try {
        const { text, options } = req.body;
        if (!text) return res.status(400).json({ error: 'text required' });
        const result = checkQuality(text, options || {});
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// XRLF-Skeletonizer tier-info
app.get('/api/tier-info', (req, res) => {
    const model = req.query.model || 'default';
    const mode  = req.query.mode  || COGNITIVE_MODE;
    const ctx   = detectContextWindow(model, mode);
    res.json({
        model,
        mode,
        context_window: ctx,
        recommended_tier: selectTier(ctx),
        service: 'XRLF/FoveatedMemory Unified Proxy v3',
        proxy_port: config.proxy_port,
        upstream: config.upstream_url
    });
});

// Skeletonize a file (XRLF-Skeletonizer native)
app.post('/api/skeletonize', (req, res) => {
    const { filepath, level = 3 } = req.body || {};
    if (!filepath) return res.status(400).json({ error: 'filepath required' });
    const candidates = [
        filepath,
        path.resolve(filepath),
        path.resolve(__dirname, '..', '..', filepath),
        path.resolve(__dirname, '..', '..', '..', filepath)
    ];
    const resolved = candidates.find(p => fs.existsSync(p));
    if (!resolved) return res.status(404).json({ error: `File '${filepath}' not found` });
    const skeleton = skeletonizeFile(resolved, level);
    if (!skeleton) return res.status(500).json({ error: 'Skeletonization failed' });
    res.json({ filepath, level, skeleton, source_hint: filepath });
});

// Expand file:line
app.get('/api/expand/:filepath(*)', (req, res) => {
    const filepath = req.params.filepath;
    const line = parseInt(req.query.line || '1', 10);
    const contextLines = parseInt(req.query.context || '3', 10);
    const candidates = [
        filepath,
        path.resolve(filepath),
        path.resolve(__dirname, '..', '..', filepath),
        path.resolve(__dirname, '..', '..', '..', filepath)
    ];
    const resolved = candidates.find(p => fs.existsSync(p));
    if (!resolved) return res.status(404).json({ error: 'File not found' });
    const expanded = expandFileLine(resolved, line, contextLines);
    if (!expanded) return res.status(500).json({ error: 'Expansion failed' });
    res.json({ filepath, line, context: contextLines, expanded });
});

// Expand hash or file:line via POST
app.post('/api/expand', (req, res) => {
    const { hash_id, filepath, line, context_lines = 3 } = req.body || {};
    if (hash_id) {
        for (const [uri, entry] of xrlCache.entries()) {
            if (uri.endsWith(`:${hash_id}`)) {
                return res.json({ hash_id, uri, expanded: entry.content });
            }
        }
        return res.status(404).json({ error: 'Hash not found in runtime cache' });
    }
    if (filepath && line != null) {
        const expanded = expandFileLine(filepath, line, context_lines);
        if (!expanded) return res.status(404).json({ error: 'File/line not found' });
        return res.json({ filepath, line, context: context_lines, expanded });
    }
    return res.status(400).json({ error: 'Provide hash_id or filepath+line' });
});

// XRL protocol stubs
app.post('/api/xrl/expand', (req, res) => {
    const { uris = [] } = req.body || {};
    const out = {};
    for (const uri of uris) {
        const parsed = parseXrl(uri);
        if (!parsed) { out[uri] = { error: 'Invalid XRL' }; continue; }
        const expanded = expandFileLine(parsed.filepath, parsed.line, 3);
        out[uri] = expanded ? { ...parsed, expanded } : { error: 'File not found' };
    }
    res.json({ expanded: out });
});

app.post('/api/xrl/resolve', (req, res) => {
    const { uri } = req.body || {};
    const parsed = parseXrl(uri);
    res.json({ uri, parsed, cached: xrlCache.has(uri) });
});

app.get('/api/xrl/status', (req, res) => {
    res.json({ namespace: XRL_NAMESPACE, cache_size: xrlCache.size, version: '3.0' });
});

app.post('/api/xrl/prune', (req, res) => {
    const maxAgeDays = parseInt(req.body?.max_age_days || '7', 10);
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    let pruned = 0;
    for (const [uri, entry] of xrlCache.entries()) {
        if (new Date(entry.created).getTime() < cutoff) {
            xrlCache.delete(uri);
            pruned++;
        }
    }
    res.json({ pruned, remaining: xrlCache.size });
});

// Semantic summary (best-effort local middleman, or extractive fallback)
app.post('/api/semantic-summary', async (req, res) => {
    const { filepath, content } = req.body || {};
    if (!filepath && !content) return res.status(400).json({ error: 'filepath or content required' });
    let text = content;
    if (!text && filepath) {
        const candidates = [
            filepath,
            path.resolve(filepath),
            path.resolve(__dirname, '..', '..', filepath),
            path.resolve(__dirname, '..', '..', '..', filepath)
        ];
        const resolved = candidates.find(p => fs.existsSync(p));
        if (!resolved) return res.status(404).json({ error: 'File not found' });
        text = fs.readFileSync(resolved, 'utf8');
    }
    try {
        const r = await fetch(`${LM_STUDIO_URL}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: process.env.XRLF_MIDDLEMAN_MODEL || 'paper-summarizer',
                messages: [
                    { role: 'system', content: 'Summarize the following file in one concise sentence.' },
                    { role: 'user', content: text.slice(0, 4000) }
                ],
                max_tokens: 150, temperature: 0.1, stream: false
            })
        });
        if (r.ok) {
            const data = await r.json();
            return res.json({ filepath, summary: data.choices?.[0]?.message?.content || 'No summary' });
        }
    } catch (e) { /* fallthrough */ }
    // Extractive fallback
    const firstLine = text.split('\n').find(l => l.trim()) || 'No content';
    res.json({ filepath, summary: `One-line extractive summary: ${firstLine.slice(0, 200)}`, fallback: true });
});

// ── Routes ──────────────────────────────────────────────────────────────────

// ── Gemini Interceptor ──────────────────────────────────────────────────────
app.post('/v1beta/models/:apiAction', async (req, res) => {
    try {
        const apiAction = req.params.apiAction;
        logDebug(`\n[${new Date().toISOString()}] Gemini Interceptor started for ${apiAction}\n`);
        
        let workspaceId = config.workspace_id;
        const auth = req.headers.authorization;
        if (auth && auth.startsWith('Bearer ')) {
            const token = auth.substring(7).trim();
            if (token && token !== 'lm-studio') workspaceId = token.replace(/[^a-zA-Z0-9_-]/g, '_');
        }
        const reqStore = getStore(workspaceId);

        const body = { ...req.body };
        
        // Fast token-minimization on the contents array
        if (body.contents && Array.isArray(body.contents)) {
            let pseudoMessages = [];
            for (let i = 0; i < body.contents.length; i++) {
                const c = body.contents[i];
                if (!c.parts || !Array.isArray(c.parts)) continue;
                for (let j = 0; j < c.parts.length; j++) {
                    const part = c.parts[j];
                    if (part.text && typeof part.text === 'string') {
                        pseudoMessages.push({
                            role: c.role || 'user',
                            content: part.text,
                            _geminiRef: { contentIndex: i, partIndex: j }
                        });
                    }
                }
            }
            
            // Apply token slayers
            pseudoMessages = pseudoMessages.map(m => ({
                ...m,
                content: stripThinking(m.content)
            }));
            pseudoMessages = dedupeFileReads(pseudoMessages);
            
            // XRL Checkpointing
            const AUTO_CHECKPOINT = process.env.XRLF_PROXY_AUTO_CHECKPOINT !== '0' && process.env.XRLF_PROXY_AUTO_CHECKPOINT !== 'false';
            if (AUTO_CHECKPOINT) {
                try {
                    pseudoMessages = await compressContext(pseudoMessages, workspaceId);
                } catch (e) {
                    console.warn('[Gemini] compressContext failed:', e.message);
                }
            }
            
            // Re-map to payload
            for (const pm of pseudoMessages) {
                if (pm._geminiRef) {
                    body.contents[pm._geminiRef.contentIndex].parts[pm._geminiRef.partIndex].text = pm.content;
                }
            }
            
            // Memory Rings
            if (body.contents.length > 0) {
                // Extract base model from apiAction (e.g. gemini-1.5-pro:generateContent -> gemini-1.5-pro)
                const modelId = apiAction.split(':')[0] || 'gemini-1.5-pro';
                const { scaledConfig } = scaleConfigForModel(modelId, config);
                const ringBlock = await buildRingBlock(reqStore, scaledConfig, workspaceId);
                if (ringBlock) {
                    const firstUser = body.contents.find(c => c.role === 'user' || c.role === 'model');
                    if (firstUser && firstUser.parts) {
                        firstUser.parts.unshift({ text: ringBlock + '\n\n' });
                    }
                }
            }
        }
        
        // System instruction strip
        if (body.systemInstruction && body.systemInstruction.parts) {
            for (let part of body.systemInstruction.parts) {
                if (part.text) part.text = stripThinking(part.text);
            }
        }

        // Forward to Google
        const apiKey = req.query.key || '';
        let upstreamUrl = `https://generativelanguage.googleapis.com/v1beta/models/${apiAction}`;
        if (apiKey) upstreamUrl += `?key=${apiKey}`;
        
        logDebug(`[${new Date().toISOString()}] before fetch to Gemini API\n`);
        
        const fwdHeaders = { 'Content-Type': 'application/json' };
        if (req.headers['x-goog-api-key']) fwdHeaders['x-goog-api-key'] = req.headers['x-goog-api-key'];
        if (req.headers['x-goog-api-client']) fwdHeaders['x-goog-api-client'] = req.headers['x-goog-api-client'];
        
        const upstreamRes = await fetch(upstreamUrl, {
            method: 'POST',
            headers: fwdHeaders,
            body: JSON.stringify(body)
        });
        
        // Stream response back transparently
        res.status(upstreamRes.status);
        upstreamRes.headers.forEach((val, key) => {
            if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(key.toLowerCase())) {
                res.setHeader(key, val);
            }
        });
        upstreamRes.body.pipe(res);
        
        upstreamRes.body.on('error', (err) => {
            console.error('[Gemini Interceptor] Stream error:', err);
        });
    } catch (err) {
        console.error(`[Gemini Interceptor] Unhandled error:`, err);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
});

app.post(['/v1/chat/completions', '/chat/completions'], (req, res) => {
    let workspaceId = config.workspace_id;
    let userId = 'anonymous';

    // Extract workspace from Bearer token
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
        const token = auth.substring(7).trim();
        
        // Multi-User / Swarm Mode Auth Routing
        const authManager = getAuthManager(path.resolve(__dirname, 'memory_data'));
        const resolved = authManager.resolveToken(token);
        workspaceId = resolved.teamId;
        userId = resolved.userId;
        req.userId = userId;
    }

    const reqStore = getStore(workspaceId);

    handleChatCompletion(req, res, null, reqStore, workspaceId).catch(err => {
        console.error(`[Server] Unhandled error in workspace ${workspaceId}:`, err);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    });
});

// Passthrough: models list — forwards to upstream (LM Studio or Ollama Cloud)
app.get(['/v1/models', '/models'], async (req, res) => {
    try {
        const modelsHeaders = {};
        if (config._cloud_mode && config._api_key) {
            modelsHeaders['Authorization'] = `Bearer ${config._api_key}`;
        }
        let data;
        try {
            const baseUrl = config.upstream_url.replace(/\/v1\/?$/, '');
            const r = await fetch(`${baseUrl}/v1/models`, { 
                headers: modelsHeaders, 
                signal: AbortSignal.timeout(3000) 
            });
            if (r.ok) {
                data = await r.json();
            }
        } catch (upstreamErr) {
            console.warn(`[Fovea] /v1/models upstream fetch failed: ${upstreamErr.message}`);
        }

        // If upstream gave us nothing usable, return the configured default model so clients can select it
        if (!data || !data.data || data.data.length === 0) {
            // Build a sensible fallback from env config
            const fallbackModels = [];
            if (UPSTREAM_MODEL) fallbackModels.push({ id: UPSTREAM_MODEL, object: 'model', created: Math.floor(Date.now()/1000), owned_by: COGNITIVE_MODE === 'cloud' ? 'ollama-cloud' : 'lmstudio' });
            // Always expose a proxy-managed "auto" entry
            // fallbackModels.push({ id: 'foveated-proxy-auto', object: 'model', created: Math.floor(Date.now()/1000), owned_by: 'foveated-proxy' });
            data = {
                object: 'list',
                data: fallbackModels
            };
            console.log(`[Fovea] /v1/models returning fallback: ${fallbackModels.map(m=>m.id).join(', ')}`);
        }
        
        // Always inject foveated-proxy-auto into the real model list
        if (data && data.data && !data.data.find(m => m.id === 'foveated-proxy-auto')) {
            // data.data.unshift({ id: 'foveated-proxy-auto', object: 'model', created: Math.floor(Date.now()/1000), owned_by: 'foveated-proxy' });
        }
        res.json(data);
    } catch (err) {
        console.error(`[Fovea] /v1/models handler failed:`, err.message);
        res.status(500).json({ error: { message: err.message, type: 'internal_error' } });
    }
});

// Extensions like Papillion often do a GET /v1/models/model_name to verify it exists
app.get(['/v1/models/:model', '/models/:model'], async (req, res) => {
    // Just mock a success response to keep the extension happy
    const modelData = {
        id: req.params.model,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "foveated-proxy"
    };
    // Inject spoofed context_window when active — fools Papillon/Cline/VS Code into thinking they have 128K
    // SAFE_MODE overrides: reports real context window instead of spoofed value
    if (SPOOF_CONTEXT_WINDOW > 0 && !SAFE_MODE) {
        modelData.context_window = SPOOF_CONTEXT_WINDOW;
        modelData.max_context_length = SPOOF_CONTEXT_WINDOW;
        console.log(`[Spoof] /v1/models/${req.params.model} → context_window=${SPOOF_CONTEXT_WINDOW}`);
    }
    res.json(modelData);
});

// Health check
app.get('/health', async (req, res) => {
    try {
        const workspaceId = req.headers['authorization']?.replace('Bearer ', '') || config.workspace_id;
        const s = getStore(workspaceId);
        const storedCount = await s.count();
        res.json({
            status: 'ONLINE',
            service: 'XRLF/FoveatedMemory Unified Proxy v3',
            workspace: workspaceId,
            upstream: config.upstream_url,
            mode: COGNITIVE_MODE,
            cloud_cap: CLOUD_MAX_TOKENS_CAP > 0 ? CLOUD_MAX_TOKENS_CAP : 'auto',
            preserve_last: PRESERVE_LAST_TURNS,
            stored_messages: storedCount,
            session: SESSION_ID,
            xrl_cache_size: xrlCache.size
        });
    } catch (err) {
        res.status(500).json({ status: 'ERROR', error: err.message });
    }
});

// Memory stats
app.get('/memory/stats', async (req, res) => {
    try {
        const workspaceId = req.headers['authorization']?.replace('Bearer ', '') || config.workspace_id;
        const s = getStore(workspaceId);
        const storedCount = await s.count();
        res.json({
            workspace_id: workspaceId,
            stored_messages: storedCount,
            session_id: SESSION_ID
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── /api/status endpoint (consumed by Jenna VSCode extension) ─────────────────

app.get('/api/status', async (req, res) => {
    try {
        const workspaceId = req.headers['authorization']?.replace('Bearer ', '') || config.workspace_id;
        const s = getStore(workspaceId);
        const totalRaw = await s.count();
        let totalThemes = await s.countThemes();
        const totalSessions = await s.countSessions();

        // Auto-consolidate raw memories into themes if themes aren't generated yet
        if (totalThemes === 0 && totalRaw > 0) {
            try {
                const resConsol = await s.consolidateRawMemories();
                totalThemes = resConsol.themesCreated;
            } catch (_) {}
        }

        res.json({
            status: 'ONLINE',
            workspace_id: workspaceId,
            compression_level: 2,
            active_blocks: 0,
            total_memories: totalRaw,
            total_themes: totalThemes,
            total_sessions: totalSessions,
            model: config.model || 'auto',
            upstream: config.upstream_url,
            session: SESSION_ID
        });
    } catch (err) {
        res.status(500).json({ status: 'ERROR', error: err.message });
    }
});

// ── /api/sessions endpoint (returns list of available sessions across all stores) ────────────────
app.get('/api/sessions', async (req, res) => {
    try {
        const workspaceId = req.headers['authorization']?.replace('Bearer ', '') || config.workspace_id;
        
        let subdirs = [];
        try {
            const memoryDataDir = path.join(__dirname, 'memory_data');
            subdirs = fs.readdirSync(memoryDataDir).filter(name => {
                try { return fs.statSync(path.join(memoryDataDir, name)).isDirectory() && name !== 'checkpoints'; }
                catch { return false; }
            });
        } catch (_) {}

        const priorityDirs = Array.from(new Set(['XRLF', 'default', 'jen', workspaceId, ...subdirs]));
        const sessionMap = new Map();

        for (const dbName of priorityDirs) {
            try {
                const storeInst = getStore(dbName);
                const sList = await storeInst.listSessions(50);
                for (const s of sList) {
                    const sid = s.session_id || s.id;
                    if (sid && (!sessionMap.has(sid) || (s.last_updated || '') > (sessionMap.get(sid).last_updated || ''))) {
                        sessionMap.set(sid, s);
                    }
                }
            } catch (_) {}
        }

        const sessions = Array.from(sessionMap.values())
            .sort((a, b) => (b.last_updated || '').localeCompare(a.last_updated || ''))
            .slice(0, 50);

        res.json({ status: 'OK', workspace_id: workspaceId, sessions });
    } catch (err) {
        res.status(500).json({ status: 'ERROR', error: err.message });
    }
});

// ── /api/session/messages endpoint (returns history for specific session) ──────
app.get('/api/session/messages', async (req, res) => {
    try {
        const workspaceId = req.headers['authorization']?.replace('Bearer ', '') || config.workspace_id;
        const sessionId = req.query.session_id || SESSION_ID;
        const s = getStore(workspaceId);
        const msgs = await s.getBySession(sessionId);
        res.json({ status: 'OK', session_id: sessionId, messages: msgs });
    } catch (err) {
        res.status(500).json({ status: 'ERROR', error: err.message });
    }
});

// ── /api/session/generate-title endpoint ───────────────────────────────────────
app.post('/api/session/generate-title', async (req, res) => {
    try {
        const workspaceId = req.headers['authorization']?.replace('Bearer ', '') || config.workspace_id;
        const sessionId = req.body.session_id;
        if (!sessionId) throw new Error("Missing session_id");
        
        let s = getStore(workspaceId);
        let msgs = await s.getBySession(sessionId);
        if (msgs.length === 0) {
            for (const fallbackId of ['default', 'XRLF']) {
                const fallbackStore = getStore(fallbackId);
                const fallbackMsgs = await fallbackStore.getBySession(sessionId);
                if (fallbackMsgs.length > 0) {
                    s = fallbackStore;
                    msgs = fallbackMsgs;
                    break;
                }
            }
        }
        if (msgs.length === 0) return res.json({ status: 'OK', title: 'Empty Session' });
        
        // Grab up to last 6 messages for context
        const recentMsgs = msgs.slice(-6).map(m => m.role + ': ' + (typeof m.content === 'string' ? m.content.slice(0, 300) : '')).join('\n');
        
        const prompt = `Analyze this chat snippet and return metadata in EXACT FORMAT.
CRITICAL RULES:
1. Do NOT output any thinking blocks, reasoning, or conversational filler.
2. Output ONLY the 5 metadata lines.
3. Keep titles human-readable and professional.

TITLE: <3-6 word descriptive summary title>
THEME: <Code|Architecture|UI|General>
PROJECT: <Project or workspace name, e.g. XRLF, Jenna, Extension, or General>
KEYWORDS_ROW1: <3-4 key topic tags, e.g. #WebXR #FoveatedMemory #VSCode>
KEYWORDS_ROW2: <3-4 key issue/action tags, e.g. #FixSessionTitles #KeywordRows #UIEnhancement>

Snippet:
${recentMsgs}`;
        
        const r = await fetch(`${LM_STUDIO_URL}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'local-model',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.2,
                max_tokens: 120
            })
        });
        
        if (!r.ok) throw new Error("LLM request failed");
        const data = await r.json();
        let raw = data.choices?.[0]?.message?.content || '';
        raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

        let title = (raw.match(/TITLE:\s*([^\n]+)/i)?.[1] || raw.split('\n')[0] || '').replace(/^["'\s]+|["'\s]+$/g, '').trim();
        title = title.replace(/[◆◇■□●○★☆▲▼#*_`]/g, '').trim();
        title = title.replace(/^(the|a|an)\s+/i, '');
        if (!title || title.length <= 3 || /^(the|a|an|untitled|session)$/i.test(title)) {
          title = 'Untitled Session';
        }
        let theme = (raw.match(/THEME:\s*([^\n]+)/i)?.[1] || 'General').trim();
        let project = (raw.match(/PROJECT:\s*([^\n]+)/i)?.[1] || workspaceId || 'XRLF').trim();
        
        let kw1 = (raw.match(/KEYWORDS_ROW1:\s*([^\n]+)/i)?.[1] || '').trim();
        let kw2 = (raw.match(/KEYWORDS_ROW2:\s*([^\n]+)/i)?.[1] || '').trim();
        
        let keywords = [kw1, kw2].filter(Boolean).join('\n');
        if (!keywords) {
          keywords = '#Session #Context';
        }

        if (!title || title.length < 3) title = 'Untitled Session';
        
        await s.setSessionMeta(sessionId, { title, theme, project, keywords, keywords_row1: kw1, keywords_row2: kw2 });
        res.json({ status: 'OK', session_id: sessionId, title, theme, project, keywords, keywords_row1: kw1, keywords_row2: kw2 });
    } catch (err) {
        logError(`[generate-title] failed: ${err.message}`);
        res.status(500).json({ status: 'ERROR', error: err.message });
    }
});

// ── /api/session/purge-and-retitle endpoint (Batch process legacy imported sessions) ─────────────
app.post('/api/session/purge-and-retitle', async (req, res) => {
    try {
        const workspaceId = req.headers['authorization']?.replace('Bearer ', '') || config.workspace_id;
        const s = getStore(workspaceId);
        const sessions = await s.getRecentSessions();
        let purged = 0;
        let retitled = 0;

        for (const sess of sessions) {
            const sid = sess.session_id || sess.id;
            if (!sid) continue;
            const msgs = await s.getBySession(sid);
            
            // Purge 1 or 2 turn sessions (stubs with no real work)
            if (msgs.length <= 2) {
                await s.deleteSession(sid).catch(() => {});
                purged++;
                continue;
            }

            // Force full retitle & keyword generation for all active sessions using last 10 messages
            const recentMsgs = msgs.slice(-10).map(m => m.role + ': ' + (typeof m.content === 'string' ? m.content.slice(0, 400) : '')).join('\n');
            const prompt = `Analyze this chat snippet (last 10 turns of session) and return metadata in EXACT FORMAT:
TITLE: <3-6 word clear, descriptive summary title of what was accomplished or discussed>
THEME: <Code|Architecture|UI|General>
PROJECT: <Project or workspace name, e.g. XRLF, Jenna, Extension, or General>
KEYWORDS_ROW1: <3-4 key topic tags, e.g. #WebXR #FoveatedMemory #VSCode>
KEYWORDS_ROW2: <3-4 key issue/action tags, e.g. #FixSessionTitles #KeywordRows #UIEnhancement>

Snippet:
${recentMsgs}`;
            try {
                const r = await fetch(`${LM_STUDIO_URL}/v1/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: 'local-model',
                        messages: [{ role: 'user', content: prompt }],
                        temperature: 0.2,
                        max_tokens: 140
                    })
                });
                if (r.ok) {
                    const data = await r.json();
                    let raw = data.choices?.[0]?.message?.content || '';
                    raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

                    let title = (raw.match(/TITLE:\s*([^\n]+)/i)?.[1] || raw.split('\n')[0] || '').replace(/^["'\s]+|["'\s]+$/g, '').trim();
                    title = title.replace(/[◆◇■□●○★☆▲▼#*_`]/g, '').trim().replace(/^(the|a|an)\s+/i, '');
                    if (!title || title.length <= 3) title = 'Untitled Session';
                    let theme = (raw.match(/THEME:\s*([^\n]+)/i)?.[1] || 'General').trim();
                    let project = (raw.match(/PROJECT:\s*([^\n]+)/i)?.[1] || workspaceId || 'XRLF').trim();
                    let kw1 = (raw.match(/KEYWORDS_ROW1:\s*([^\n]+)/i)?.[1] || '').trim();
                    let kw2 = (raw.match(/KEYWORDS_ROW2:\s*([^\n]+)/i)?.[1] || '').trim();
                    let keywords = [kw1, kw2].filter(Boolean).join('\n');
                    
                    await s.setSessionMeta(sid, { title, theme, project, keywords, keywords_row1: kw1, keywords_row2: kw2 });
                    retitled++;
                }
            } catch (_) {}
        }
        res.json({ status: 'OK', purged, retitled, total: sessions.length });
    } catch (err) {
        logError(`[purge-and-retitle] failed: ${err.message}`);
        res.status(500).json({ status: 'ERROR', error: err.message });
    }
});

// ── /api/session/ingredients endpoint (Full session deep index & ingredients list) ─────────────
app.post('/api/session/ingredients', async (req, res) => {
    try {
        const workspaceId = req.headers['authorization']?.replace('Bearer ', '') || config.workspace_id;
        const { session_id } = req.body;
        if (!session_id) return res.status(400).json({ error: 'session_id required' });

        let s = getStore(workspaceId);
        let msgs = await s.getBySession(session_id);
        if (msgs.length === 0) {
            for (const fallbackId of ['default', 'XRLF']) {
                const fallbackStore = getStore(fallbackId);
                const fallbackMsgs = await fallbackStore.getBySession(session_id);
                if (fallbackMsgs.length > 0) {
                    s = fallbackStore;
                    msgs = fallbackMsgs;
                    break;
                }
            }
        }
        if (msgs.length === 0) return res.json({ status: 'OK', ingredients: '' });

        let sampleMsgs = msgs;
        if (msgs.length > 12) {
            sampleMsgs = [...msgs.slice(0, 4), ...msgs.slice(Math.floor(msgs.length/2) - 2, Math.floor(msgs.length/2) + 2), ...msgs.slice(-4)];
        }
        const fullSnippet = sampleMsgs.map(m => m.role + ': ' + (typeof m.content === 'string' ? m.content.slice(0, 250) : '')).join('\n');

        const prompt = `Analyze this full session snippet and extract a detailed Ingredients Index:
SUMMARY: <2-sentence summary of what was accomplished>
TOPICS: <comma-separated key technical topics>
INGREDIENTS: <bullet points of files, APIs, components, or functions touched>

Snippet:
${fullSnippet}`;

        const r = await fetch(`${LM_STUDIO_URL}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'local-model',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.2,
                max_tokens: 150
            })
        });

        if (!r.ok) throw new Error("LLM request failed");
        const data = await r.json();
        let raw = data.choices?.[0]?.message?.content || '';
        raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

        let summary = (raw.match(/SUMMARY:\s*([^\n]+)/i)?.[1] || '').trim();
        let topics = (raw.match(/TOPICS:\s*([^\n]+)/i)?.[1] || '').trim();
        let ingredientsRaw = (raw.match(/INGREDIENTS:\s*([\s\S]+)/i)?.[1] || raw).trim();

        await s.setSessionMeta(session_id, { summary, topics, ingredients: ingredientsRaw });
        res.json({ status: 'OK', session_id, summary, topics, ingredients: ingredientsRaw });
    } catch (err) {
        logError(`[ingredients] failed: ${err.message}`);
        res.status(500).json({ status: 'ERROR', error: err.message });
    }
});

// ── /api/consolidate endpoint (trigger theme consolidation) ───────────────────
app.post('/api/consolidate', async (req, res) => {
    try {
        const workspaceId = req.headers['authorization']?.replace('Bearer ', '') || config.workspace_id;
        const s = getStore(workspaceId);
        const result = await s.consolidateRawMemories();
        res.json({ status: 'OK', ...result });
    } catch (err) {
        res.status(500).json({ status: 'ERROR', error: err.message });
    }
});

// ═══ Settings / Control Panel API (user-initiated only; no watchdog loops) ═══

const envFilePath = path.resolve(__dirname, '..', '..', '.env');

function readEnv() {
    if (!fs.existsSync(envFilePath)) return '';
    return fs.readFileSync(envFilePath, 'utf8');
}

function writeEnv(content) {
    fs.writeFileSync(envFilePath, content, 'utf8');
}

function setEnvVar(key, value) {
    const lines = readEnv().split(/\r?\n/);
    const replacement = `${key}=${value}`;
    let found = false;
    const out = lines.map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return line;
        const eq = trimmed.indexOf('=');
        if (eq === -1) return line;
        const k = trimmed.slice(0, eq).trim();
        if (k !== key) return line;
        found = true;
        // Preserve any inline comment
        const commentMatch = line.match(/\s+#.*$/);
        const comment = commentMatch ? commentMatch[0] : '';
        return `${key}=${value}${comment}`;
    });
    if (!found) out.push(replacement);
    writeEnv(out.join('\n'));
}

function applyFrontendPreset(ui) {
    const uiNorm = String(ui).toLowerCase().trim();
    if (!['xr_vessel', '3d_avatar'].includes(uiNorm)) return;

    // XR Vessel and 3D Avatar both serve plain HTTP locally; Cloudflare provides public HTTPS.
    const isXr = uiNorm === 'xr_vessel';
    const targetPort = isXr ? '5176' : '8080';
    const targetProtocol = 'http';

    setEnvVar('XRLF_FRONTEND_UI', uiNorm);
    setEnvVar('VITE_URL', `${targetProtocol}://127.0.0.1:${targetPort}`);

    // Update Cloudflare tunnel config if it exists
    const tunnelConfigPath = path.resolve(__dirname, '..', '..', 'config.yml');
    try {
        let raw = fs.readFileSync(tunnelConfigPath, 'utf8');
        // Replace the whole ingress block for XRLF.1um6a.se atomically
        raw = raw.replace(
            /hostname:\s*XRLF\.1um6a\.se\r?\n\s*service:\s*http[s]*:\/\/[^\r\n]+(?:\r?\n\s*noTLSVerify:\s*true)?/,
            isXr
                ? `hostname: XRLF.1um6a.se\n    service: http://127.0.0.1:5176`
                : `hostname: XRLF.1um6a.se\n    service: http://127.0.0.1:8080`
        );
        fs.writeFileSync(tunnelConfigPath, raw, 'utf8');
        console.log(`[Setting] Tunnel config updated → ${targetProtocol}://127.0.0.1:${targetPort}`);
    } catch (e) {
        console.warn('[Setting] Tunnel config update skipped:', e.message);
    }

    // Touch .env so Sleipnir's watchdog redeploys the frontend node
    try {
        const envPath = path.resolve(__dirname, '..', '..', '.env');
        const now = new Date();
        fs.utimesSync(envPath, now, now);
    } catch (e) {
        console.warn('[Setting] .env touch failed:', e.message);
    }
}

function runPwsh(command, callback) {
    execFile(PWSH, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
        cwd: path.resolve(__dirname, '..', '..'),
        windowsHide: true
    }, (err, stdout, stderr) => {
        if (callback) callback(err, stdout, stderr);
    });
}

app.use(express.json());

app.post('/api/setting', (req, res) => {
    const { key, val } = req.body || {};
    if (!key) return res.status(400).json({ error: 'missing key' });
    setEnvVar(key, String(val));
    process.env[key] = String(val);

    // Auto-load new model in LM Studio if key is XRLF_MODEL_LOCAL_ID
    if (key === 'XRLF_MODEL_LOCAL_ID') {
        const modelId = String(val).trim();
        console.log(`[Setting] Switching active local model to ${modelId}...`);
        execFile('lms', ['load', modelId, '--identifier', modelId, '-y'], { timeout: 90000, windowsHide: true }, (err) => {
            if (err) console.warn(`[Setting] Failed to auto-load ${modelId}:`, err.message);
            else console.log(`[Setting] ✅ Successfully loaded ${modelId} in LM Studio.`);
        });
    }

    // Frontend preset: apply atomically (also updates tunnel + VITE_URL)
    if (key === 'XRLF_FRONTEND_UI_PRESET' && ['xr_vessel', '3d_avatar'].includes(String(val))) {
        applyFrontendPreset(String(val));
    }

    res.json({ ok: true, [key]: val });
});

app.get('/api/env', (req, res) => {
    const envPath = path.resolve(__dirname, '..', '..', '.env');
    const out = {};
    try {
        const raw = fs.readFileSync(envPath, 'utf8');
        for (const line of raw.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
            const eq = trimmed.indexOf('=');
            const k = trimmed.slice(0, eq).trim();
            let v = trimmed.slice(eq + 1).trim();
            if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
                v = v.slice(1, -1);
            }
            out[k] = v;
        }
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
    res.json(out);
});

app.post('/api/toggle', (req, res) => {
    const { name, value } = req.body || {};
    if (!name) return res.status(400).json({ error: 'missing name' });
    const envName = name === 'voice' ? 'XRLF_VOICE_ENABLED' : name === 'mic' ? 'XRLF_MIC_ENABLED' : name;
    setEnvVar(envName, value ? 'true' : 'false');
    res.json({ ok: true, [envName]: value ? 'true' : 'false' });
});

app.post('/api/route', (req, res) => {
    const { mode } = req.body || {};
    if (!['cloud', 'local'].includes(mode)) return res.status(400).json({ error: 'mode must be cloud or local' });

    // Atomic .env update for route switch (do not restart proxy from inside itself)
    if (mode === 'local') {
        setEnvVar('XRLF_COGNITIVE_MODE', 'local');
        setEnvVar('XRLF_CHAT_PROVIDER', 'lm_studio');
        setEnvVar('XRLF_LOCAL_BASE_URL', 'http://127.0.0.1:7272/v1');
        setEnvVar('LM_STUDIO_URL', 'http://127.0.0.1:7272');
        setEnvVar('LOCAL_LLM_BASE', 'http://127.0.0.1:7272');
        process.env.XRLF_COGNITIVE_MODE = 'local';
        process.env.XRLF_CHAT_PROVIDER = 'lm_studio';
        process.env.XRLF_LOCAL_BASE_URL = 'http://127.0.0.1:7272/v1';
        process.env.LM_STUDIO_URL = 'http://127.0.0.1:7272';
        process.env.LOCAL_LLM_BASE = 'http://127.0.0.1:7272';
    } else {
        setEnvVar('XRLF_COGNITIVE_MODE', 'cloud');
        setEnvVar('XRLF_CHAT_PROVIDER', 'ollama_cloud');
        process.env.XRLF_COGNITIVE_MODE = 'cloud';
        process.env.XRLF_CHAT_PROVIDER = 'ollama_cloud';
    }

    res.json({ ok: true, mode });
});

app.post('/api/fovea', (req, res) => {
    let { level } = req.body || {};
    if (typeof level === 'string') level = parseInt(level, 10);
    if (typeof level !== 'number' || isNaN(level) || level < 0 || level > 6) return res.status(400).json({ error: 'level must be 0-6' });

    setEnvVar('XRLF_PROXY_AGGRESSION', String(level));
    process.env.XRLF_PROXY_AGGRESSION = String(level);
    res.json({ ok: true, level });
});

app.post('/api/cap', (req, res) => {
    const { cap } = req.body || {};
    if (typeof cap !== 'number' || cap < 0) return res.status(400).json({ error: 'cap must be >= 0' });
    setEnvVar('XRLF_CLOUD_MAX_TOKENS_CAP', String(cap));
    res.json({ ok: true, cap });
});

app.post('/api/preserve', (req, res) => {
    const { preserve } = req.body || {};
    if (typeof preserve !== 'number' || preserve < 0 || preserve > 100) return res.status(400).json({ error: 'preserve must be 0-100' });
    setEnvVar('XRLF_CLOUD_PRESERVE_LAST', String(preserve));
    process.env.XRLF_CLOUD_PRESERVE_LAST = String(preserve);
    res.json({ ok: true, preserve });
});

app.post('/api/control', (req, res) => {
    const { action } = req.body || {};
    const allowed = ['start-stack', 'stop-stack', 'open-tray', 'open-terminal', 'open-debug-terminal', 'show-meter', 'unload-lm', 'restart-local', 'open-quick-controls', 'open-corner-companion', 'open-topbar', 'restart-proxy', 'test-news-impulse'];
    if (!allowed.includes(action)) return res.status(400).json({ error: 'unknown action' });

    const repoRoot = path.resolve(__dirname, '..', '..');
    const sendOk = () => res.json({ ok: true, action });
    const sendErr = (err) => res.status(500).json({ error: err?.message || String(err) });
    switch (action) {
        case 'start-stack':
            execFile('C:\\Windows\\System32\\cmd.exe', ['/c', 'start', '/min', '', 'node', 'sleipnir_launcher.js'], {
                cwd: repoRoot,
                windowsHide: true,
                detached: true
            }, (err) => err ? sendErr(err) : sendOk());
            break;
        case 'stop-stack':
            runPwsh(`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*sleipnir_launcher.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`, (err) => err ? sendErr(err) : sendOk());
            break;
        case 'open-tray':
            execFile('C:\\Windows\\System32\\cmd.exe', ['/c', 'start', '', path.join(repoRoot, 'XRLF_Taskbar.pyw')], { windowsHide: true }, (err) => err ? sendErr(err) : sendOk());
            break;
        case 'open-terminal':
            execFile(WT_EXE, ['new-tab', '--profile', 'XRLF Super Memory', '-d', repoRoot], { windowsHide: true }, (err) => err ? sendErr(err) : sendOk());
            break;
        case 'open-debug-terminal':
            execFile(WT_EXE, ['new-tab', '--profile', 'XRLF Super Memory', '-d', repoRoot, '--title', 'XRLF Debug'], { windowsHide: true }, (err) => err ? sendErr(err) : sendOk());
            break;
        case 'show-meter':
            runPwsh('Import-Module XRLFMemory; Show-MemoryMeter', (err) => err ? sendErr(err) : sendOk());
            break;
        case 'unload-lm':
            fetch('http://127.0.0.1:1234/v1/models', { timeout: 5000 })
                .then(r => r.json())
                .then(data => Promise.all((data.data || []).map(m =>
                    fetch(`http://127.0.0.1:1234/v1/models/${m.id}/unload`, { method: 'POST', timeout: 5000 })
                )))
                .then(() => sendOk())
                .catch(e => sendErr(e));
            break;
        case 'restart-local':
            runPwsh('Restart-Service -Name "LMStudio*" -Force -ErrorAction SilentlyContinue', (err) => err ? sendErr(err) : sendOk());
            break;
        case 'open-quick-controls':
        case 'open-corner-companion':
            execFile('C:\\Windows\\System32\\cmd.exe', ['/c', 'start', '', 'python', path.join(repoRoot, 'Tools', 'XRLF_top_bar', 'XRLF_top_bar.py'), '--quick-controls'], { windowsHide: true }, (err) => err ? sendErr(err) : sendOk());
            break;
        case 'open-topbar':
            execFile('C:\\Windows\\System32\\cmd.exe', ['/c', 'start', '', 'python', path.join(repoRoot, 'Tools', 'XRLF_top_bar', 'XRLF_top_bar.py'), '--mode=topbar'], { windowsHide: true }, (err) => err ? sendErr(err) : sendOk());
            break;
        case 'restart-proxy':
            sendOk();
            setTimeout(() => { process.exit(0); }, 500);
            break;
        case 'test-news-impulse':
            execFile('C:\\Windows\\System32\\cmd.exe', ['/c', 'python', path.join(repoRoot, 'Backend', 'Cognition', 'SituationalAwarenessDaemon.py'), '--test-run'], { windowsHide: true }, (err) => err ? sendErr(err) : sendOk());
            break;
    }
});

// ── Process-level crash protection ──────────────────────────────────────────
// Prevents NSSM watchdog restart loops: log errors but keep the process alive.

process.on('uncaughtException', (err) => {
    console.error(`[Fovea] uncaughtException (suppressed):`, err.message);
    console.error(err.stack || err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error(`[Fovea] unhandledRejection (suppressed):`, reason);
});

// ── Start ───────────────────────────────────────────────────────────────────

const _server = http.createServer(app);
_server.on('connect', (req, clientSocket, head) => {
    logDebug(`\n[${new Date().toISOString()}] Caught HTTP CONNECT request for ${req.url}! Express ignored this, causing a hang.\n`);
    clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\nTransparent proxy does not support CONNECT tunnels.');
    clientSocket.end();
});

_server.listen(config.proxy_port, '127.0.0.1', () => {
    console.log(`✅ Foveated Memory Proxy listening on http://localhost:${config.proxy_port}`);
    console.log(`   → Point your client at: http://localhost:${config.proxy_port}/v1/chat/completions\n`);

    // ── Memory Continuity: restore previous session state ──────────────
    try {
        const snapshot = loadContinuity();
        if (snapshot && snapshot.sessionId) {
            console.log(`[Continuity] 🔄 Previous session found: ${snapshot.sessionId}`);
            console.log(`[Continuity]    Last activity: ${snapshot.timestamp}`);
            console.log(`[Continuity]    Messages: ${snapshot.messageCount || 'unknown'}`);
            console.log(`[Continuity]    Model: ${snapshot.model || 'unknown'}`);
        } else {
            console.log('[Continuity] ℹ️ No previous session state found — fresh start');
        }
    } catch (e) {
        console.warn('[Continuity] Failed to load continuity state:', e.message);
    }

    // --- Automatic Public Tunnel ---
    console.log(`\n[Tunnel] Starting dedicated public tunnel for Google Orchestrator...`);
    const { spawn } = require('child_process');
    // set your own localtunnel subdomain
    const tunnel = spawn(npxCmd, ['-y', 'localtunnel', '--port', config.proxy_port, '--subdomain', 'foveated-memory-public'], { shell: true });
    
    tunnel.stdout.on('data', data => {
        const out = data.toString().trim();
        if (out) console.log(`[Tunnel] ${out}`);
    });
    tunnel.stderr.on('data', data => {
        const err = data.toString().trim();
        if (err) console.error(`[Tunnel Error] ${err}`);
    });

    // Auto-load configured models in LM Studio on startup
    const modelsToLoad = [...new Set([MIDDLEMAN_MODEL, UPSTREAM_MODEL])].filter(Boolean);
    console.log(`[Startup] Ensuring required models are loaded in LM Studio: ${modelsToLoad.join(', ')}`);
    
    execFile('lms', ['ps'], { timeout: 15000, windowsHide: true }, (err, stdout) => {
        modelsToLoad.forEach(modelId => {
            // We use 'lms ps' because LM Studio's HTTP API is known to have a bug where it 
            // hides models from scripts, causing duplicate loading and OOM crashes. 'lms ps' is reliable.
            if (!err && stdout && stdout.includes(modelId)) {
                console.log(`[Startup] ✅ ${modelId} is already loaded in LM Studio. Skipping load to protect VRAM.`);
            } else {
                console.log(`[Startup] ⚠️ ${modelId} not found. Auto-loading ${modelId} model in LM Studio...`);
                execFile('lms', ['load', modelId, '--gpu', 'max', '-y'], { timeout: 90000, windowsHide: true }, (loadErr) => {
                    if (loadErr) {
                        console.warn(`[Startup] Failed to auto-load ${modelId} in LM Studio:`, loadErr.message);
                    } else {
                        console.log(`[Startup] ✅ ${modelId} successfully loaded in LM Studio.`);
                    }
                });
            }
        });
    });
});

const _dashboardServer = dashboardApp.listen(DASHBOARD_PORT, '127.0.0.1', () => {
    console.log(`🖥️  Foveated Memory Dashboard on http://localhost:${DASHBOARD_PORT}/memory`);
});

// Allow immediate restart after a crash/kill by reusing the port during TIME_WAIT.
_server.on('connection', (socket) => { /* no-op for typing */ });
_server.on('listening', () => {
    if (_server.address()) {
        _server.setMaxListeners(0);
    }
});

// Handle EADDRINUSE gracefully — exit 0 so NSSM watchdog can cleanly restart
_server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`[Fovea] Port ${config.proxy_port} already in use — exiting gracefully for watchdog restart.`);
        process.exit(0);
    } else {
        console.error(`[Fovea] Server error:`, err);
    }
});

// ── Ecological Context Background Worker (Cron Sweeper) ─────────────────────
async function runEcologicalContextWorker() {
    try {
        const memoryDataDir = path.join(__dirname, 'memory_data');
        let subdirs = [];
        try {
            subdirs = fs.readdirSync(memoryDataDir).filter(name => {
                try { return fs.statSync(path.join(memoryDataDir, name)).isDirectory() && name !== 'checkpoints'; }
                catch { return false; }
            });
        } catch (_) {}

        const workspaceIds = Array.from(new Set(['XRLF', 'default', config.workspace_id, ...subdirs]));

        for (const wsId of workspaceIds) {
            const s = getStore(wsId);
            const sessions = await s.listSessions(100);
            for (const sess of sessions) {
                const sId = sess.session_id;
                const turnCount = sess.count || sess.turn_count || 0;
                const cleanT = (sess.title || '').replace(/^["'\s]+|["'\s]+$/g, '').trim();

                // 1. Delete useless stub/junk sessions (<= 2 turns)
                if (turnCount <= 2) {
                    console.log(`[EcologicalWorker] Pruning 1-2 turn stub session: ${sId}`);
                    await s.deleteSession(sId);
                    continue;
                }

                // 2. Refresh condition: missing/bad title, missing keywords, OR topic drift (every 12 turns since last title refresh)
                const isBadTitle = !cleanT || cleanT.length <= 4 || /^(the|a|an|in|on|untitled|session|session #\w+)$/i.test(cleanT) || cleanT.endsWith('...') || cleanT.toLowerCase().startsWith('the ');
                const lastTitledTurn = sess.last_titled_turn || 0;
                const turnsSinceLastTitle = turnCount - lastTitledTurn;
                const isDrifted = turnsSinceLastTitle >= 12;

                if (!isBadTitle && sess.keywords && !isDrifted) continue;

                try {
                    let msgs = await s.getBySession(sId);
                    if (msgs.length > 0) {
                        const recentMsgs = msgs.slice(-10).map(m => m.role + ': ' + (typeof m.content === 'string' ? m.content.slice(0, 300) : '')).join('\n');
                        const prompt = `Analyze this chat snippet (last 10 turns of session) and return metadata in EXACT FORMAT:
TITLE: <3-6 word clear, descriptive summary title of what was accomplished or discussed>
THEME: <Code|Architecture|UI|General>
PROJECT: <Project or workspace name, e.g. XRLF, Jenna, Extension, or General>
KEYWORDS_ROW1: <3-4 key topic tags, e.g. #WebXR #FoveatedMemory #VSCode>
KEYWORDS_ROW2: <3-4 key issue/action tags, e.g. #FixSessionTitles #KeywordRows #UIEnhancement>

Snippet:
${recentMsgs}`;
                        const r = await fetch(`${LM_STUDIO_URL}/v1/chat/completions`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                model: 'mixture-summarizer-qwen3.5-2b',
                                messages: [{ role: 'user', content: prompt }],
                                temperature: 0.2,
                                max_tokens: 140
                            })
                        });
                        if (r.ok) {
                            const data = await r.json();
                            let raw = data.choices?.[0]?.message?.content || '';
                            raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

                            let title = (raw.match(/TITLE:\s*([^\n]+)/i)?.[1] || raw.split('\n')[0] || '').replace(/^["'\s]+|["'\s]+$/g, '').trim();
                            title = title.replace(/[◆◇■□●○★☆▲▼#*_`]/g, '').trim().replace(/^(the|a|an)\s+/i, '');
                            if (!title || title.length <= 3) title = 'Untitled Session';
                            let theme = (raw.match(/THEME:\s*([^\n]+)/i)?.[1] || 'General').trim();
                            let project = (raw.match(/PROJECT:\s*([^\n]+)/i)?.[1] || wsId || 'XRLF').trim();
                            let kw1 = (raw.match(/KEYWORDS_ROW1:\s*([^\n]+)/i)?.[1] || '').trim();
                            let kw2 = (raw.match(/KEYWORDS_ROW2:\s*([^\n]+)/i)?.[1] || '').trim();
                            let keywords = [kw1, kw2].filter(Boolean).join('\n');

                            await s.setSessionMeta(sId, { 
                                title, 
                                keywords, 
                                keywords_row1: kw1, 
                                keywords_row2: kw2, 
                                theme, 
                                project,
                                last_titled_turn: turnCount
                            });
                            console.log(`[EcologicalWorker] ${isDrifted ? 'Drift refreshed' : 'Retitled'} ${sId} @ turn ${turnCount} -> "${title}"`);
                        }
                    }
                    // Gentle throttle delay (1.5 seconds) between background generations to prevent GPU/CPU spikes
                    await new Promise(r => setTimeout(r, 1500));
                } catch (e) {
                    console.warn(`[EcologicalWorker] Title generation failed for ${sId}: ${e.message}`);
                }
            }
        }
    } catch (e) {
        console.warn(`[EcologicalWorker] Sweeper error: ${e.message}`);
    }
}

// Start ecological context sweeper (runs 5s after start, then every 3 minutes)
setTimeout(runEcologicalContextWorker, 5000);
setInterval(runEcologicalContextWorker, 180000);


