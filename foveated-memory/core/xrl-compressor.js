/**
 * ═══════════════════════════════════════════════════════
 * XRL COMPRESSOR — Foveated Memory Ring Compression
 * ═══════════════════════════════════════════════════════
 *
 * Compresses conversation turns at 6 levels of fidelity,
 * matching the gradient from fovea (raw) to outer periphery (atomic).
 *
 * Level 0 — Raw (0% compression)    — verbatim messages
 * Level 1 — Light (~50%)            — key phrases + outcome
 * Level 2 — Medium (~75%)           — topic + key fact only
 * Level 3 — Deep (~88%)             — topic + timestamp + one-liner
 * Level 4 — Ultra (~95%)            — topic label + XRL hash ref
 * Level 5 — Atomic (~98%)           — pure XRL hash only
 */

'use strict';

const crypto = require('crypto');

/**
 * Generate a short XRL hash for a message block.
 * Format: xrl://mem/<4-char-hash>
 */
function xrlHash(text) {
    const h = crypto.createHash('md5').update(text).digest('hex').slice(0, 4);
    return `xrl://mem/${h}`;
}

/**
 * Extract the dominant topic from a message using simple heuristics.
 * In a future phase, this can be replaced with an LLM call.
 */
function extractTopic(text, maxWords = 6) {
    // Strip common filler words
    const stopWords = new Set([
        'the','a','an','is','it','in','on','at','to','of','and','or',
        'for','with','this','that','was','are','be','as','we','i','you',
        'have','had','has','do','did','not','but','so','if','by','can',
        'will','just','from','they','he','she','also','been','what','how'
    ]);
    const words = text.toLowerCase()
        .replace(/[^a-z0-9\s\-]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopWords.has(w));

    // Deduplicate and take first N
    const seen = new Set();
    const unique = [];
    for (const w of words) {
        if (!seen.has(w)) { seen.add(w); unique.push(w); }
        if (unique.length >= maxWords) break;
    }
    return unique.join(' ') || text.slice(0, 40);
}

/**
 * Compress a set of messages at the given level.
 * Messages is an array of { role, content, timestamp, id } objects.
 * Returns a formatted string block ready for injection into a prompt.
 */
function compress(messages, level, tokenBudget = 999) {
    if (!messages || messages.length === 0) return '';

    const lines = [];
    let approxTokens = 0;

    for (const msg of messages) {
        if (approxTokens >= tokenBudget) break;

        const ts = msg.timestamp
            ? new Date(msg.timestamp).toISOString().slice(0, 10)
            : 'unknown';
        const role = (msg.role || 'unknown').toUpperCase();
        const rawContent = msg.content || '';
        const content = (Array.isArray(rawContent)
            ? rawContent.filter(p => p && typeof p.text === 'string').map(p => p.text).join('\n')
            : String(rawContent)
        ).trim();
        const hash = xrlHash(content);

        let line = '';

        switch (level) {
            case 0:
                // Raw — verbatim
                line = `[${ts}] ${role}: ${content}`;
                break;

            case 1:
                // Light — role + first 200 chars + topic
                line = `[${ts}] ${role}: ${content.slice(0, 200)}${content.length > 200 ? '…' : ''}`;
                break;

            case 2:
                // Medium — topic + key sentence
                {
                    const topic = extractTopic(content);
                    const firstSentence = content.split(/[.!?]/)[0].trim().slice(0, 100);
                    line = `[${ts}] (${topic}) → ${firstSentence}`;
                }
                break;

            case 3:
                // Deep — topic + timestamp one-liner
                {
                    const topic = extractTopic(content, 4);
                    line = `[${ts}] ${topic}`;
                }
                break;

            case 4:
                // Ultra — topic label + hash ref
                {
                    const topic = extractTopic(content, 3);
                    line = `[${ts}] ${topic} ${hash}`;
                }
                break;

            case 5:
                // Atomic — hash only
                line = hash;
                break;

            default:
                line = `[${ts}] ${role}: ${content.slice(0, 100)}`;
        }

        // Rough token estimate: 1 token ≈ 4 chars
        const tokenEst = Math.ceil(line.length / 4);
        if (approxTokens + tokenEst > tokenBudget) break;

        lines.push(line);
        approxTokens += tokenEst;
    }

    return lines.join('\n');
}

/**
 * Estimate token count for a string (rough: 1 token ≈ 4 chars).
 */
function estimateTokens(text) {
    return Math.ceil((text || '').length / 4);
}

module.exports = { compress, xrlHash, extractTopic, estimateTokens };
