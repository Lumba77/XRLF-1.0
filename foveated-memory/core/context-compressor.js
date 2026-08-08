/**
 * ═══════════════════════════════════════════════════════
 * XRL CONTEXT CHECKPOINTER
 * ═══════════════════════════════════════════════════════
 *
 * Compresses old conversation turns into dense XRL-hashed
 * checkpoints using local Ollama — zero cloud tokens burned.
 *
 * Strategy:
 *  - Keep last FOVEA_WINDOW turns verbatim (recent context)
 *  - Every COMPRESS_EVERY turns, summarize the oldest batch
 *  - Replace with a [CKP:hash] token block (~40-80 tokens)
 *  - Net reduction: 80-90% on 20+ turn sessions
 */

'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const fetch  = require('node-fetch');

// ── Config ──────────────────────────────────────────────────────────────────

// Target ~10x reduction (e.g. 80K -> 8K) instead of ~100x, which destroys context.
// Tune with env vars without editing code.
const COMPRESS_EVERY  = parseInt(process.env.FOVEA_COMPRESS_EVERY,  10) || 6;
const FOVEA_WINDOW    = parseInt(process.env.FOVEA_WINDOW,          10) || 4;
const SUMMARY_MAX_TOKENS = parseInt(process.env.FOVEA_SUMMARY_TOKENS, 10) || 300;
const LM_STUDIO_URL   = process.env.LM_STUDIO_URL || 'http://127.0.0.1:7272';
const CHECKPOINT_DIR  = path.join(__dirname, '..', 'memory_data', 'checkpoints');

// Ensure checkpoint dir exists
if (!fs.existsSync(CHECKPOINT_DIR)) fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });

// ── Helpers ──────────────────────────────────────────────────────────────────

function hashContent(text) {
    return crypto.createHash('sha256').update(text).digest('hex').slice(0, 6);
}

function saveCheckpoint(hash, data) {
    const file = path.join(CHECKPOINT_DIR, `${hash}.json`);
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function loadCheckpoint(hash) {
    const file = path.join(CHECKPOINT_DIR, `${hash}.json`);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ── LM Studio Summarizer ─────────────────────────────────────────────────────

async function summarizeWithLMStudio(messages) {
    const turns = messages.map(m =>
        `${m.role.toUpperCase()}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`
    ).join('\n\n');

    try {
        const COMPRESS_MODEL = process.env.LUMAX_MIDDLEMAN_MODEL || process.env.LOCAL_LLM_MODEL || process.env.LUMAX_MODEL_LOCAL_ID || 'qwopus3.5-9b-coder-mtp-moq';
        const res = await fetch(`${LM_STUDIO_URL}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: COMPRESS_MODEL,
                messages: [
                    { role: 'system', content: 'You are a conversation checkpoint encoder. Preserve decisions, files, status, and key facts. Be concise but informative.' },
                    { role: 'user', content:
`Compress these conversation turns into a checkpoint of max ${SUMMARY_MAX_TOKENS} tokens.

Format EXACTLY:
DECISIONS: <key decisions/conclusions>
FILES: <files created/modified, or "none">
STATUS: <solved|pending|in-progress>
CONTEXT: <critical facts next agent must know>

Conversation:
${turns}

CHECKPOINT:`
                    }
                ],
                max_tokens: Math.max(100, SUMMARY_MAX_TOKENS + 50),
                temperature: 0.1,
                stream: false
            }),
            signal: AbortSignal.timeout(20000)
        });

        if (!res.ok) throw new Error(`LM Studio ${res.status}: ${await res.text()}`);
        const data = await res.json();
        const rawContent = data.choices?.[0]?.message?.content;
        if (!rawContent) return null;
        const text = Array.isArray(rawContent)
            ? rawContent.filter(p => p && typeof p.text === 'string').map(p => p.text).join('\n')
            : String(rawContent);
        return text.trim() || null;
    } catch (err) {
        console.warn('[Compressor] LM Studio unreachable, using extractive fallback:', err.message);
        return null;
    }
}

// ── Extractive Fallback (no LLM needed) ─────────────────────────────────────

function extractiveSummary(messages) {
    // Extract key signal without LLM: file names, decisions, status keywords
    const combined = messages.map(m =>
        typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    ).join(' ');

    const files = [...combined.matchAll(/[\w\-]+\.(py|js|ts|json|md|txt|html|css)/g)]
        .map(m => m[0]).filter((v, i, a) => a.indexOf(v) === i).slice(0, 8).join(', ') || 'none';

    const solved = combined.match(/solved|confirmed|done|complete/i) ? 'solved' :
                   combined.match(/pending|waiting/i) ? 'pending' : 'in-progress';

    // Grab first 400 chars of last assistant message as context
    const lastAssist = [...messages].reverse().find(m => m.role === 'assistant');
    const snippet = lastAssist
        ? (typeof lastAssist.content === 'string' ? lastAssist.content : '').slice(0, 400)
        : 'no assistant message';

    const decisions = combined.match(/DECISIONS?:\s*([^\n]+)/gi)?.slice(0,3).join('; ') || 'extracted from turns';

    return `DECISIONS: ${decisions}\nFILES: ${files}\nSTATUS: ${solved}\nCONTEXT: ${snippet}`;
}

// ── Main Compressor ──────────────────────────────────────────────────────────

/**
 * Compress old conversation turns into XRL checkpoints based on requested level (1-5).
 * Returns a new messages array with old turns replaced by checkpoint blocks.
 *
 * @param {Array} messages  - Full messages array from request body
 * @param {string} sessionId - Session identifier for tracking
 * @param {number} level     - XLR Compression level (1: light 50% -> 5: atomic 98%)
 * @returns {Array} - Compressed messages array
 */
async function compressContext(messages, sessionId = 'default', level = 3) {
    const lvl = Math.max(1, Math.min(5, parseInt(level, 10) || 3));
    
    // Dynamic window tuning based on level:
    // Level 1: Light (~50%)   - keep 8 recent turns, compress every 10
    // Level 2: Medium (~75%)  - keep 6 recent turns, compress every 8
    // Level 3: Balanced (~88%) - keep 4 recent turns, compress every 6 (default)
    // Level 4: High (~93%)    - keep 2 recent turns, compress every 4
    // Level 5: Atomic (~98%)  - keep 1 recent turn, compress every 3
    const dynamicWindow   = lvl === 1 ? 8 : lvl === 2 ? 6 : lvl === 3 ? 4 : lvl === 4 ? 2 : 1;
    const dynamicCompress = lvl === 1 ? 10 : lvl === 2 ? 8 : lvl === 3 ? 6 : lvl === 4 ? 4 : 3;

    console.log(`[Compressor] ▶️ entry | session=${sessionId} | level=${lvl} | total=${messages.length} | system=${messages.filter(m => m.role === 'system').length} | turns=${messages.filter(m => m.role !== 'system').length}`);
    // Filter to only user/assistant turns (exclude system messages)
    const systemMsgs  = messages.filter(m => m.role === 'system');
    const turnMsgs    = messages.filter(m => m.role !== 'system');

    // Not enough turns to compress
    if (turnMsgs.length < dynamicCompress + dynamicWindow) {
        console.log(`[Compressor] ⏭️ skip | turnMsgs=${turnMsgs.length} < threshold=${dynamicCompress + dynamicWindow}`);
        return messages;
    }

    // Split: batch to compress vs recent fovea window
    const compressCount = turnMsgs.length - dynamicWindow;
    // Round down to nearest dynamicCompress batch
    const batchSize = Math.floor(compressCount / dynamicCompress) * dynamicCompress;
    if (batchSize <= 0) {
        console.log(`[Compressor] ⏭️ skip | batchSize=${batchSize}`);
        return messages;
    }
    console.log(`[Compressor] 📊 level=${lvl} compressCount=${compressCount} batchSize=${batchSize} keep=${dynamicWindow}`);

    const toCompress = turnMsgs.slice(0, batchSize);
    const toKeep     = turnMsgs.slice(batchSize);

    // Build checkpoint blocks for each dynamicCompress-sized batch
    const checkpointBlocks = [];
    for (let i = 0; i < toCompress.length; i += dynamicCompress) {
        const batch     = toCompress.slice(i, i + dynamicCompress);
        const batchText = batch.map(m =>
            `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`
        ).join('\n');

        const hash = hashContent(batchText);

        // Check if already compressed (cached)
        let cached = loadCheckpoint(hash);
        if (!cached) {
            console.log(`[Compressor] Compressing turns ${i+1}-${i+batch.length} → [CKP:${hash}]`);
            const summary = await summarizeWithLMStudio(batch) || extractiveSummary(batch);
            cached = {
                hash,
                session: sessionId,
                turnRange: [i + 1, i + batch.length],
                timestamp: new Date().toISOString(),
                summary,
                raw: batch  // store raw for expandability
            };
            saveCheckpoint(hash, cached);
        }

        checkpointBlocks.push(`[CKP:${hash} @ turns ${cached.turnRange[0]}-${cached.turnRange[1]} | ${cached.timestamp.slice(0,10)}]\n${cached.summary}`);
    }

    // Reconstruct: system + one compressed history block + recent turns
    const compressedHistoryMsg = {
        role: 'system',
        content: `=== COMPRESSED HISTORY (XRL Checkpoints) ===\n${checkpointBlocks.join('\n---\n')}\n=== END COMPRESSED HISTORY ===\n\nRecent ${FOVEA_WINDOW} turns follow verbatim.`
    };

    const result = [
        ...systemMsgs,
        compressedHistoryMsg,
        ...toKeep
    ];

    const savedTurns  = toCompress.length;
    const savedTokens = Math.round(savedTurns * 600); // ~600 tokens avg per turn
    console.log(`[Compressor] ✅ Compressed ${savedTurns} turns → ${checkpointBlocks.length} checkpoints (~${savedTokens} tokens saved) | resultMessages=${result.length}`);

    return result;
}

/**
 * Expand a checkpoint hash back to full content (for debugging/recall).
 */
function expandCheckpoint(hash) {
    return loadCheckpoint(hash);
}

/**
 * List all stored checkpoints for a session.
 */
function listCheckpoints() {
    if (!fs.existsSync(CHECKPOINT_DIR)) return [];
    return fs.readdirSync(CHECKPOINT_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => {
            const data = JSON.parse(fs.readFileSync(path.join(CHECKPOINT_DIR, f), 'utf8'));
            return { hash: data.hash, session: data.session, turnRange: data.turnRange, timestamp: data.timestamp };
        });
}

module.exports = { compressContext, expandCheckpoint, listCheckpoints };
