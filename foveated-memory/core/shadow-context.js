/**
 * ═══════════════════════════════════════════════════════
 * SHADOW CONTEXT — Zoom-Inable Disc Persistence
 * ═══════════════════════════════════════════════════════
 *
 * Saves full uncompressed context blocks to disc before they
 * get aggressively compressed by the XRL pipeline. The model
 * can "zoom in" on any shadow block via <zoom: "hash"> to
 * retrieve 100% of the original content on demand.
 *
 * Architecture:
 *
 *   4K Live Context Window (foveated, aggressive compression)
 *   ├── Ring 0: last 2-3 turns RAW (highest fidelity)
 *   ├── Ring 1: recent session ~50% compressed
 *   ├── Ring 2: older context ~80% compressed
 *   ├── Ring 3: deep past ~95% compressed (hash refs only)
 *   └── Repo skeleton: general structure (slim, no compiled bones)
 *
 *   Shadow Context (on disc, full fidelity, zoom-inable)
 *   ├── shadow-context/<session>/
 *   │   ├── <hash>.json  — full raw content of each compressed block
 *   │   └── index.json   — searchable index (topics, files, timestamps)
 *
 * When the model needs deeper context, it emits:
 *   <zoom: "hash"> or <zoom: "search phrase">
 *
 * The interceptor retrieves the shadow block and injects it
 * as a system message, then re-invokes the LLM.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Config ──────────────────────────────────────────────────────────────────

const SHADOW_DIR = process.env.XRLF_SHADOW_CONTEXT_DIR
    ? path.resolve(process.env.XRLF_SHADOW_CONTEXT_DIR)
    : path.join(__dirname, '..', 'memory_data', 'shadow-context');

// Maximum shadow blocks per session (oldest evicted beyond this)
const MAX_SHADOW_BLOCKS = parseInt(process.env.XRLF_SHADOW_MAX_BLOCKS || '500', 10);

// Maximum size per shadow block in chars (safety cap)
const MAX_BLOCK_CHARS = parseInt(process.env.XRLF_SHADOW_MAX_BLOCK_CHARS || '50000', 10);

// ── Helpers ──────────────────────────────────────────────────────────────────

function hashContent(content) {
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 10);
}

function ensureSessionDir(sessionId) {
    const dir = path.join(SHADOW_DIR, sessionId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function getIndexPath(sessionId) {
    return path.join(ensureSessionDir(sessionId), 'index.json');
}

function loadIndex(sessionId) {
    const idxPath = getIndexPath(sessionId);
    try {
        if (fs.existsSync(idxPath)) {
            return JSON.parse(fs.readFileSync(idxPath, 'utf8'));
        }
    } catch (_) {}
    return { session: sessionId, blocks: [], updatedAt: new Date().toISOString() };
}

function saveIndex(sessionId, index) {
    index.updatedAt = new Date().toISOString();
    const idxPath = getIndexPath(sessionId);
    fs.writeFileSync(idxPath, JSON.stringify(index, null, 2), 'utf8');
}

// ── Core: Save Shadow Block ─────────────────────────────────────────────────

/**
 * Save a block of messages as a shadow context block on disc.
 * Called BEFORE compression destroys the original content.
 *
 * @param {string} sessionId - Session identifier
 * @param {Array<object>} messages - The raw messages to shadow
 * @param {object} metadata - Extra metadata { turnRange, topics, files }
 * @returns {object} { hash, token, path } - The shadow reference
 */
function saveShadowBlock(sessionId, messages, metadata = {}) {
    if (!messages || messages.length === 0) return null;

    // Serialize messages to full content
    const content = messages.map(m => {
        const text = typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
                ? m.content.filter(p => p && typeof p.text === 'string').map(p => p.text).join('\n')
                : JSON.stringify(m.content);
        return { role: m.role, content: text, timestamp: m.timestamp || null };
    });

    const serialized = JSON.stringify(content);
    if (serialized.length > MAX_BLOCK_CHARS) {
        // Block too large — split would be ideal, but for now just truncate the shadow
        // The live context still gets the full compressed version
    }

    const hash = hashContent(serialized);
    const dir = ensureSessionDir(sessionId);
    const blockPath = path.join(dir, `${hash}.json`);

    // Extract topics and files for the searchable index
    const fullText = content.map(m => m.content).join('\n');
    const topics = extractTopics(fullText);
    const files = extractFiles(fullText);

    const block = {
        hash,
        session: sessionId,
        timestamp: new Date().toISOString(),
        turnRange: metadata.turnRange || null,
        topics,
        files,
        messageCount: content.length,
        charCount: serialized.length,
        messages: content
    };

    // Don't re-save if already exists
    if (!fs.existsSync(blockPath)) {
        fs.writeFileSync(blockPath, JSON.stringify(block, null, 2), 'utf8');
    }

    // Update index
    const index = loadIndex(sessionId);
    // Remove stale entry if same hash exists
    index.blocks = index.blocks.filter(b => b.hash !== hash);
    index.blocks.push({
        hash,
        timestamp: block.timestamp,
        turnRange: block.turnRange,
        topics,
        files,
        messageCount: block.messageCount,
        charCount: block.charCount
    });

    // Enforce max blocks (evict oldest)
    if (index.blocks.length > MAX_SHADOW_BLOCKS) {
        index.blocks.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        const evicted = index.blocks.splice(0, index.blocks.length - MAX_SHADOW_BLOCKS);
        // Delete evicted block files
        for (const ev of evicted) {
            const evPath = path.join(dir, `${ev.hash}.json`);
            try { if (fs.existsSync(evPath)) fs.unlinkSync(evPath); } catch (_) {}
        }
    }

    saveIndex(sessionId, index);

    return {
        hash,
        token: `[ZOOM:${hash}]`,
        path: blockPath,
        topics,
        files
    };
}

// ── Core: Retrieve Shadow Block ─────────────────────────────────────────────

/**
 * Retrieve a shadow block by hash.
 *
 * @param {string} sessionId
 * @param {string} hash
 * @returns {object|null} The full shadow block or null
 */
function getShadowBlock(sessionId, hash) {
    const dir = ensureSessionDir(sessionId);
    const blockPath = path.join(dir, `${hash}.json`);
    try {
        if (fs.existsSync(blockPath)) {
            return JSON.parse(fs.readFileSync(blockPath, 'utf8'));
        }
    } catch (_) {}
    return null;
}

/**
 * Search shadow blocks by keyword (searches topics, files, and content).
 *
 * @param {string} sessionId
 * @param {string} query - Search phrase
 * @param {number} maxResults
 * @returns {Array<object>} Matching blocks (metadata only, not full content)
 */
function searchShadowBlocks(sessionId, query, maxResults = 5) {
    const index = loadIndex(sessionId);
    const q = query.toLowerCase();
    const words = q.split(/\s+/).filter(w => w.length > 2);

    const scored = index.blocks.map(block => {
        let score = 0;
        // Topic match (high weight)
        for (const topic of block.topics || []) {
            if (topic.toLowerCase().includes(q) || q.includes(topic.toLowerCase())) {
                score += 10;
            }
            for (const w of words) {
                if (topic.toLowerCase().includes(w)) score += 3;
            }
        }
        // File match (high weight)
        for (const file of block.files || []) {
            if (file.toLowerCase().includes(q) || q.includes(file.toLowerCase())) {
                score += 8;
            }
            for (const w of words) {
                if (file.toLowerCase().includes(w)) score += 2;
            }
        }
        // Turn range match
        if (block.turnRange) {
            const turnMatch = q.match(/turn\s*(\d+)/i);
            if (turnMatch) {
                const turnNum = parseInt(turnMatch[1], 10);
                if (turnNum >= block.turnRange[0] && turnNum <= block.turnRange[1]) {
                    score += 15;
                }
            }
        }
        return { ...block, score };
    });

    return scored
        .filter(b => b.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults);
}

/**
 * Build a zoom injection message from a shadow block.
 * This gets injected as a system message so the model sees the full content.
 *
 * @param {object} block - The full shadow block
 * @returns {object} System message with restored content
 */
function buildZoomInjection(block) {
    const lines = block.messages.map(m =>
        `[${m.timestamp ? new Date(m.timestamp).toISOString().slice(0, 19) : 'unknown'}] ${m.role.toUpperCase()}: ${m.content}`
    ).join('\n\n');

    return {
        role: 'system',
        content: `[SHADOW CONTEXT ZOOM — hash:${block.hash} | turns ${block.turnRange ? block.turnRange.join('-') : '?'} | ${block.messageCount} messages | ${block.charCount} chars]\n\n${lines}\n\n[END SHADOW ZOOM — full fidelity restored. Continue your response.]`
    };
}

// ── Extraction Helpers ───────────────────────────────────────────────────────

function extractTopics(text, maxTopics = 5) {
    const stopWords = new Set([
        'the','a','an','is','it','in','on','at','to','of','and','or','for',
        'with','this','that','was','are','be','as','we','i','you','have',
        'had','has','do','did','not','but','so','if','by','can','will',
        'just','from','they','he','she','also','been','what','how','like',
        'um','uh','well','ok','okay','yeah','no','yes'
    ]);
    const words = text.toLowerCase()
        .replace(/[^a-z0-9\s\-\.]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 3 && !stopWords.has(w));

    const freq = {};
    for (const w of words) {
        freq[w] = (freq[w] || 0) + 1;
    }

    return Object.entries(freq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, maxTopics)
        .map(([word]) => word);
}

function extractFiles(text) {
    const matches = text.match(/[\w\-]+\.(py|js|ts|json|md|txt|html|css|yaml|yml|xml|kt|rs|go|java|cpp|c|h|sh|bat|ps1)/gi);
    if (!matches) return [];
    return [...new Set(matches)].slice(0, 10);
}

// ── Stats & Management ───────────────────────────────────────────────────────

/**
 * Get statistics about shadow context for a session.
 */
function getStats(sessionId) {
    const index = loadIndex(sessionId);
    const dir = ensureSessionDir(sessionId);
    let totalBytes = 0;
    try {
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'index.json');
        for (const f of files) {
            totalBytes += fs.statSync(path.join(dir, f)).size;
        }
    } catch (_) {}

    return {
        session: sessionId,
        totalBlocks: index.blocks.length,
        totalBytes,
        totalKB: Math.round(totalBytes / 1024),
        oldestBlock: index.blocks[0]?.timestamp || null,
        newestBlock: index.blocks[index.blocks.length - 1]?.timestamp || null,
        allTopics: [...new Set(index.blocks.flatMap(b => b.topics || []))].slice(0, 20),
        allFiles: [...new Set(index.blocks.flatMap(b => b.files || []))].slice(0, 20)
    };
}

/**
 * Clear shadow context for a session.
 */
function clearSession(sessionId) {
    const dir = path.join(SHADOW_DIR, sessionId);
    try {
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    } catch (_) {}
}

/**
 * List all sessions with shadow context.
 */
function listSessions() {
    if (!fs.existsSync(SHADOW_DIR)) return [];
    return fs.readdirSync(SHADOW_DIR)
        .filter(f => fs.statSync(path.join(SHADOW_DIR, f)).isDirectory())
        .map(sessionId => ({
            sessionId,
            ...getStats(sessionId)
        }));
}

// ── Export ─────────────────────────────────────────────────────────────────

module.exports = {
    saveShadowBlock,
    getShadowBlock,
    searchShadowBlocks,
    buildZoomInjection,
    getStats,
    clearSession,
    listSessions,
    hashContent
};
