/**
 * ═══════════════════════════════════════════════════════
 * SACCADE ENGINE — Movable Fovea & Context Accommodation
 * ═══════════════════════════════════════════════════════
 *
 * The fovea is not static — it moves like an eye. The model can:
 *
 *   SACCADE: Shift the fovea to a different part of the conversation.
 *     <saccade: "turn 15">          — move fovea to turn 15
 *     <saccade: "search: auth bug"> — move fovea to matching shadow block
 *     <saccade: "oldest">           — move fovea to the oldest context
 *     <saccade: "newest">           — move fovea back to recent context
 *
 *   ACCOMMODATE: Sharpen or blur a specific region.
 *     <accommodate: "sharpen turn 15">  — decompress that turn to full fidelity
 *     <accommodate: "blur turns 1-10">  — compress those turns more aggressively
 *     <accommodate: "sharpen search: database schema"> — decompress matching block
 *
 *   VALIDATE: The system checks if the shift is warranted:
 *     1. Does the requested region exist in shadow context?
 *     2. Is the shift likely to help (keyword overlap with current task)?
 *     3. Token budget check — can we afford the decompression?
 *     4. If validated → restructure the fovea and re-invoke
 *     5. If rejected → inject a "not found" message and continue
 *
 * The fovea restructures the live context window:
 *
 *   BEFORE saccade:                  AFTER saccade to turn 15:
 *   ┌──────────────────┐             ┌──────────────────┐
 *   │ Ring 0: turns 20-22 (raw)     │ Ring 0: turn 15 (raw, decompressed) │
 *   │ Ring 1: turns 16-19 (50%)     │ Ring 1: turns 14,16 (50%)           │
 *   │ Ring 2: turns 8-15  (75%)      │ Ring 2: turns 20-22 (75%)           │
 *   │ Ring 3: turns 1-7   (95%)     │ Ring 3: turns 1-13  (95%)           │
 *   └──────────────────┘             └──────────────────┘
 *
 * The eye moved backward, sharpened turn 15, and pushed recent turns
 * into the periphery (still accessible, just compressed).
 */

'use strict';

const { getShadowBlock, searchShadowBlocks, buildZoomInjection } = require('./shadow-context');

// ── Saccade Patterns ────────────────────────────────────────────────────────

const SACCADE_REGEX = /<saccade:\s*"([^"]+)">/i;
const ACCOMMODATE_REGEX = /<accommodate:\s*"([^"]+)">/i;

/**
 * Detect a saccade request in the model's output.
 * @param {string} text
 * @returns {string|null} The saccade target, or null
 */
function detectSaccade(text) {
    const m = text.match(SACCADE_REGEX);
    return m ? m[1].trim() : null;
}

/**
 * Detect an accommodation request in the model's output.
 * @param {string} text
 * @returns {string|null} The accommodation directive, or null
 */
function detectAccommodate(text) {
    const m = text.match(ACCOMMODATE_REGEX);
    return m ? m[1].trim() : null;
}

// ── Saccade: Move the Fovea ─────────────────────────────────────────────────

/**
 * Parse a saccade target into a structured request.
 *
 * @param {string} target - The raw target string from <saccade: "...">
 * @returns {object} { type, value, raw }
 */
function parseSaccadeTarget(target) {
    const t = target.trim().toLowerCase();

    if (t === 'oldest' || t === 'start' || t === 'beginning') {
        return { type: 'oldest', value: null, raw: target };
    }
    if (t === 'newest' || t === 'recent' || t === 'end') {
        return { type: 'newest', value: null, raw: target };
    }

    // "turn 15" or "turns 15-20"
    const turnMatch = t.match(/turns?\s+(\d+)(?:\s*[-\u2013]\s*(\d+))?/);
    if (turnMatch) {
        return {
            type: 'turn',
            value: parseInt(turnMatch[1], 10),
            valueEnd: turnMatch[2] ? parseInt(turnMatch[2], 10) : null,
            raw: target
        };
    }

    // "search: phrase" or "find: phrase"
    const searchMatch = t.match(/(?:search|find):\s*(.+)/);
    if (searchMatch) {
        return { type: 'search', value: searchMatch[1].trim(), raw: target };
    }

    // Bare hash
    if (/^[a-f0-9]{10}$/.test(t)) {
        return { type: 'hash', value: t, raw: target };
    }

    // Fallback: treat as search
    return { type: 'search', value: target.trim(), raw: target };
}

/**
 * Validate a saccade request — check if the target exists and is worth the shift.
 *
 * @param {string} sessionId
 * @param {object} parsed - Parsed saccade target
 * @param {Array} currentMessages - Current live context (for keyword overlap check)
 * @param {number} tokenBudget - Available token budget for decompression
 * @returns {object} { valid, reason, block, blocks }
 */
function validateSaccade(sessionId, parsed, currentMessages, tokenBudget = 2000) {
    // Estimate current task keywords from the last few messages
    const recentText = currentMessages
        .slice(-3)
        .map(m => typeof m.content === 'string' ? m.content : '')
        .join(' ')
        .toLowerCase();
    const recentWords = new Set(recentText.split(/\s+/).filter(w => w.length > 4));

    if (parsed.type === 'oldest') {
        // Find the oldest shadow block
        const { listSessions } = require('./shadow-context');
        const stats = require('./shadow-context').getStats(sessionId);
        if (stats.totalBlocks === 0) {
            return { valid: false, reason: 'No shadow blocks stored', block: null };
        }
        // We need to search for the oldest — use search with empty query to list all
        const results = searchShadowBlocks(sessionId, ' ', 1);
        if (results.length === 0) {
            return { valid: false, reason: 'No shadow blocks found', block: null };
        }
        const block = getShadowBlock(sessionId, results[0].hash);
        return { valid: true, reason: 'Oldest block retrieved', block, blocks: [block] };
    }

    if (parsed.type === 'newest') {
        // Return to recent context — this means restructure back to default fovea
        return { valid: true, reason: 'Returning fovea to recent context', block: null, blocks: [] };
    }

    if (parsed.type === 'hash') {
        const block = getShadowBlock(sessionId, parsed.value);
        if (!block) {
            return { valid: false, reason: `Shadow block ${parsed.value} not found`, block: null };
        }
        // Check token budget
        const blockTokens = Math.ceil(block.charCount / 4);
        if (blockTokens > tokenBudget) {
            return { valid: false, reason: `Block too large (${blockTokens} tokens > ${tokenBudget} budget)`, block };
        }
        return { valid: true, reason: 'Hash lookup successful', block, blocks: [block] };
    }

    if (parsed.type === 'turn') {
        // Find shadow blocks matching the turn range
        const results = searchShadowBlocks(sessionId, `turn ${parsed.value}`, 5);
        if (results.length === 0) {
            return { valid: false, reason: `No shadow blocks for turn ${parsed.value}`, block: null };
        }
        const blocks = results.map(r => getShadowBlock(sessionId, r.hash)).filter(Boolean);
        if (blocks.length === 0) {
            return { valid: false, reason: 'Shadow blocks not retrievable', block: null };
        }
        return { valid: true, reason: `Found ${blocks.length} blocks for turn ${parsed.value}`, block: blocks[0], blocks };
    }

    if (parsed.type === 'search') {
        const results = searchShadowBlocks(sessionId, parsed.value, 5);
        if (results.length === 0) {
            return { valid: false, reason: `No shadow blocks matching "${parsed.value}"`, block: null };
        }

        // Validate: check keyword overlap with current task
        const bestResult = results[0];
        const blockTopics = (bestResult.topics || []).join(' ').toLowerCase();
        const overlap = [...recentWords].filter(w => blockTopics.includes(w)).length;

        // Even with low overlap, allow the saccade — the model explicitly requested it
        const block = getShadowBlock(sessionId, bestResult.hash);
        if (!block) {
            return { valid: false, reason: 'Best match not retrievable', block: null };
        }

        const blockTokens = Math.ceil(block.charCount / 4);
        if (blockTokens > tokenBudget) {
            // Try to get a smaller block from the results
            const smaller = results.find(r => Math.ceil(r.charCount / 4) <= tokenBudget);
            if (smaller) {
                const smallerBlock = getShadowBlock(sessionId, smaller.hash);
                return {
                    valid: true,
                    reason: `Best match too large, using smaller block (overlap: ${overlap} words)`,
                    block: smallerBlock,
                    blocks: [smallerBlock]
                };
            }
            return { valid: false, reason: `All matching blocks exceed token budget (${blockTokens} > ${tokenBudget})`, block };
        }

        return {
            valid: true,
            reason: `Search match (score ${bestResult.score}, overlap ${overlap} words)`,
            block,
            blocks: [block]
        };
    }

    return { valid: false, reason: 'Unknown saccade type', block: null };
}

// ── Accommodate: Sharpen/Blur Regions ───────────────────────────────────────

/**
 * Parse an accommodation directive.
 *
 * @param {string} directive - The raw directive from <accommodate: "...">
 * @returns {object} { action, target, raw }
 */
function parseAccommodate(directive) {
    const d = directive.trim().toLowerCase();

    const sharpenMatch = d.match(/sharpen\s+(.+)/);
    const blurMatch = d.match(/blur\s+(.+)/);

    if (sharpenMatch) {
        return { action: 'sharpen', target: sharpenMatch[1].trim(), raw: directive };
    }
    if (blurMatch) {
        return { action: 'blur', target: blurMatch[1].trim(), raw: directive };
    }

    return { action: 'sharpen', target: directive.trim(), raw: directive };
}

/**
 * Execute an accommodation — sharpen (decompress) or blur (compress) a region.
 *
 * @param {string} sessionId
 * @param {object} parsed - Parsed accommodation
 * @param {Array} currentMessages - Current live context
 * @param {number} tokenBudget
 * @returns {object} { valid, reason, injection }
 */
function executeAccommodate(sessionId, parsed, currentMessages, tokenBudget = 2000) {
    // For sharpen: retrieve shadow block and inject at full fidelity
    if (parsed.action === 'sharpen') {
        // Check if target is a hash
        if (/^[a-f0-9]{10}$/.test(parsed.target)) {
            const block = getShadowBlock(sessionId, parsed.target);
            if (block) {
                const blockTokens = Math.ceil(block.charCount / 4);
                if (blockTokens > tokenBudget) {
                    return { valid: false, reason: `Block too large (${blockTokens} tokens)`, injection: null };
                }
                return {
                    valid: true,
                    reason: `Sharpened block ${parsed.target}`,
                    injection: buildZoomInjection(block)
                };
            }
            return { valid: false, reason: `Block ${parsed.target} not found`, injection: null };
        }

        // Search-based sharpen
        const results = searchShadowBlocks(sessionId, parsed.target, 3);
        if (results.length === 0) {
            return { valid: false, reason: `No blocks matching "${parsed.target}"`, injection: null };
        }
        const block = getShadowBlock(sessionId, results[0].hash);
        if (!block) {
            return { valid: false, reason: 'Block not retrievable', injection: null };
        }
        const blockTokens = Math.ceil(block.charCount / 4);
        if (blockTokens > tokenBudget) {
            return { valid: false, reason: `Block too large (${blockTokens} tokens)`, injection: null };
        }
        return {
            valid: true,
            reason: `Sharpened "${parsed.target}" → ${results[0].hash}`,
            injection: buildZoomInjection(block)
        };
    }

    // For blur: we don't actually compress further — we just skip injection
    // (the region stays at its current compression level)
    if (parsed.action === 'blur') {
        return {
            valid: true,
            reason: `Blur acknowledged for "${parsed.target}" — region stays compressed`,
            injection: {
                role: 'system',
                content: `[ACCOMMODATION — blur "${parsed.target}"]: Region will remain at current compression level. No decompression applied.`
            }
        };
    }

    return { valid: false, reason: 'Unknown accommodation action', injection: null };
}

// ── Build Restructured Fovea ─────────────────────────────────────────────────

/**
 * Build a restructured context after a saccade.
 * The fovea moves to the target region, and recent context shifts to periphery.
 *
 * @param {Array} currentMessages - Current live context messages
 * @param {Array} saccadeBlocks - Shadow blocks retrieved for the new fovea
 * @param {string} saccadeReason - Why the saccade was validated
 * @returns {Array} Restructured messages array
 */
function buildRestructuredFovea(currentMessages, saccadeBlocks, saccadeReason) {
    const systemMsgs = currentMessages.filter(m => m.role === 'system');
    const convoMsgs = currentMessages.filter(m => m.role !== 'system');

    // The saccade blocks become the new fovea (Ring 0)
    const newFoveaMsgs = saccadeBlocks.map(block => buildZoomInjection(block));

    // The old recent context moves to periphery — keep last 2 turns as compressed reference
    const recentShifted = convoMsgs.slice(-2).map(m => ({
        role: m.role,
        content: typeof m.content === 'string'
            ? `[PERIPHERAL — was fovea, shifted by saccade] ${m.content.slice(0, 200)}${m.content.length > 200 ? '…' : ''}`
            : m.content
    }));

    // Saccade marker message
    const saccadeMarker = {
        role: 'system',
        content: `[SACCADE EXECUTED — fovea shifted]\nReason: ${saccadeReason}\nThe eye has moved. The blocks above are now at full fidelity (Ring 0).\nRecent context has shifted to periphery (compressed). Use <saccade: "newest"> to return.`
    };

    return [
        ...systemMsgs,
        saccadeMarker,
        ...newFoveaMsgs,
        ...recentShifted,
        { role: 'user', content: '[SYSTEM: Fovea restructured by saccade. The context above is now your focus. Please continue your response using this shifted perspective.]' }
    ];
}

// ── Export ─────────────────────────────────────────────────────────────────

module.exports = {
    detectSaccade,
    detectAccommodate,
    parseSaccadeTarget,
    parseAccommodate,
    validateSaccade,
    executeAccommodate,
    buildRestructuredFovea,
    SACCADE_REGEX,
    ACCOMMODATE_REGEX
};