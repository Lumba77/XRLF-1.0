/**
 * ═══════════════════════════════════════════════════════
 * RETINA — Value Classifier & Context Router
 * ═══════════════════════════════════════════════════════
 *
 * The retina is the sensory layer of the foveated memory eye.
 * It evaluates incoming context (light) and routes it:
 *
 *   HIGH VALUE   → Shadow Context (disc, full fidelity, zoom-inable)
 *   MEDIUM VALUE → XRL Checkpoint (compressed hash, cheap)
 *   LOW VALUE    → Ephemeral (kept in live context, compressed normally)
 *   ZERO VALUE   → DISCARDED (lost forever, no disc footprint)
 *
 * Value signals (what makes context worth keeping):
 *   - Code blocks / file edits          → HIGH (exact content matters)
 *   - Decisions / architecture choices  → HIGH (reversing them is costly)
 *   - Error diagnoses / fixes            → HIGH (must not repeat mistakes)
 *   - Task boards / to-do lists         → HIGH (crucial anchors)
 *   - User preferences / instructions   → HIGH (identity continuity)
 *   - Questions / clarifications         → MEDIUM (context for answers)
 *   - Status updates / progress          → MEDIUM (trajectory matters)
 *   - Greetings / acknowledgments       → LOW (social, not technical)
 *   - Repetitive / filler text           → ZERO (noise)
 *   - System boilerplate / headers      → ZERO (structural, not content)
 *
 * The classifier is heuristic-first (zero latency) with an optional
 * LLM "gnist" pass for ambiguous cases. The gnist is a tiny local
 * model that acts as a retinal ganglion cell — it fires only when
 * the heuristic can't decide.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Value Levels ─────────────────────────────────────────────────────────────

const VALUE = {
    HIGH:    'high',     // → shadow context (disc, full fidelity)
    MEDIUM:  'medium',   // → XRL checkpoint (compressed)
    LOW:     'low',      // → ephemeral (live context, compressed normally)
    ZERO:    'zero'      // → discarded (lost forever)
};

// ── Heuristic Signal Patterns ────────────────────────────────────────────────

const HIGH_SIGNALS = [
    // Code & files
    { pattern: /```[\s\S]*?```/g, weight: 15, label: 'code_block' },
    { pattern: /(?:^|\n)\s*(?:async\s+)?(?:function|class|def|const|let|var)\s+\w+/gm, weight: 10, label: 'code_definition' },
    { pattern: /(?:created|modified|updated|edited|wrote|saved)\s+[\w\-\.\/]+\.(py|js|ts|json|md|yaml|yml|xml|html|css|kt|rs|go)/gi, weight: 12, label: 'file_edit' },
    { pattern: /(?:^|\n)\s*[-*]\s+\[[ xX]\]\s+/gm, weight: 8, label: 'todo_item' },

    // Decisions & architecture
    { pattern: /\b(?:DECISION|DECIDED|CHOSE|WENT WITH|ARCHITECTURE|DESIGN|APPROACH)\b/gi, weight: 10, label: 'decision' },
    { pattern: /\b(?:ROOT CAUSE|FIX|SOLUTION|RESOLVED|SOLVED)\b/gi, weight: 12, label: 'diagnosis' },
    { pattern: /\b(?:ERROR|BUG|CRASH|FAILURE|EXCEPTION|STACK TRACE)\b/gi, weight: 8, label: 'error' },

    // Task & intent
    { pattern: /\[ACTIVE TASK BOARD[\s\S]*?\]/gi, weight: 15, label: 'task_board' },
    { pattern: /\[AGENT HUD[\s\S]*?\]/gi, weight: 12, label: 'agent_hud' },
    { pattern: /GOAL\s*\/\s*INTENT:/gi, weight: 10, label: 'red_thread' },

    // User preferences & identity
    { pattern: /\b(?:PREFER|LIKE|WANT|NEED|REQUIRE|MUST|ALWAYS|NEVER)\b/gi, weight: 6, label: 'preference' },
    { pattern: /\b(?:I am|I'm|my name|call me)\b/gi, weight: 5, label: 'identity' },

    // Important data
    { pattern: /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g, weight: 3, label: 'timestamp' },
    { pattern: /\b(?:API_KEY|TOKEN|SECRET|PASSWORD|URL|ENDPOINT|PORT)\s*[=:]/gi, weight: 7, label: 'config_value' },
];

const ZERO_SIGNALS = [
    { pattern: /^(?:ok|okay|sure|yes|yeah|no|nope|uh|um|hmm|right|got it|makes sense|i see|understood)\s*[.!?]?$/gim, weight: 5, label: 'acknowledgment' },
    { pattern: /^(?:hello|hi|hey|thanks|thank you|cheers|bye|goodbye|see you)\s*[.!?]?$/gim, weight: 4, label: 'greeting' },
    { pattern: /^(?:\s*\n)+$/gm, weight: 3, label: 'whitespace' },
    { pattern: /^(?:\[.*?\])\s*$/gm, weight: 2, label: 'bracket_only' },
];

const MEDIUM_SIGNALS = [
    { pattern: /\b(?:what|why|how|when|where|who)\b/gi, weight: 2, label: 'question' },
    { pattern: /\b(?:status|progress|update|current|state|working on)\b/gi, weight: 3, label: 'status' },
    { pattern: /\b(?:maybe|perhaps|might|could|possibly|consider)\b/gi, weight: 2, label: 'suggestion' },
];

// ── Core: Classify a single message ─────────────────────────────────────────

/**
 * Classify the value of a single message.
 *
 * @param {object} message - { role, content }
 * @param {object} opts - { useGnist, gnistFn }
 * @returns {object} { value, score, signals, route }
 */
function classifyMessage(message, opts = {}) {
    const content = typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
            ? message.content.filter(p => p && typeof p.text === 'string').map(p => p.text).join('\n')
            : '';

    if (!content || content.trim().length === 0) {
        return { value: VALUE.ZERO, score: 0, signals: ['empty'], route: 'discard' };
    }

    const trimmed = content.trim();
    let score = 0;
    const signals = [];

    // Check high-value signals
    for (const sig of HIGH_SIGNALS) {
        const matches = trimmed.match(sig.pattern);
        if (matches) {
            score += sig.weight * Math.min(matches.length, 3); // cap at 3 matches
            signals.push(`${sig.label}(${matches.length})`);
        }
    }

    // Subtract zero-value signals
    let zeroScore = 0;
    for (const sig of ZERO_SIGNALS) {
        const matches = trimmed.match(sig.pattern);
        if (matches) {
            zeroScore += sig.weight * matches.length;
            signals.push(`zero:${sig.label}(${matches.length})`);
        }
    }

    // Check medium-value signals (only if not already high)
    if (score < 10) {
        for (const sig of MEDIUM_SIGNALS) {
            const matches = trimmed.match(sig.pattern);
            if (matches) {
                score += sig.weight * Math.min(matches.length, 2);
                signals.push(`${sig.label}(${matches.length})`);
            }
        }
    }

    // Length bonus — longer messages tend to have more substance
    if (trimmed.length > 500) score += 2;
    if (trimmed.length > 2000) score += 3;

    // Role bonus — user messages with instructions are valuable
    if (message.role === 'user' && trimmed.length > 100) score += 2;
    // System messages are structural — medium by default
    if (message.role === 'system') score += 1;

    // Zero override — if zero signals dominate and score is low
    if (zeroScore >= 5 && score < 5) {
        return { value: VALUE.ZERO, score: -zeroScore, signals, route: 'discard' };
    }

    // Determine value level
    let value, route;
    if (score >= 10) {
        value = VALUE.HIGH;
        route = 'shadow';
    } else if (score >= 4) {
        value = VALUE.MEDIUM;
        route = 'checkpoint';
    } else if (score >= 1) {
        value = VALUE.LOW;
        route = 'ephemeral';
    } else {
        value = VALUE.ZERO;
        route = 'discard';
    }

    // Optional gnist pass for ambiguous cases (score near boundaries)
    if (opts.useGnist && opts.gnistFn && (score >= 3 && score <= 8)) {
        try {
            const gnistVerdict = opts.gnistFn(content, { score, signals });
            if (gnistVerdict && gnistVerdict.value) {
                value = gnistVerdict.value;
                route = value === VALUE.HIGH ? 'shadow'
                      : value === VALUE.MEDIUM ? 'checkpoint'
                      : value === VALUE.LOW ? 'ephemeral'
                      : 'discard';
                signals.push(`gnist:${gnistVerdict.reason || 'ambiguous'}`);
            }
        } catch (_) { /* gnist failure = fall back to heuristic */ }
    }

    return { value, score, signals, route };
}

// ── Core: Classify a batch of messages ──────────────────────────────────────

/**
 * Classify a batch of messages and route them accordingly.
 *
 * @param {Array} messages - Array of message objects
 * @param {object} opts - Classification options
 * @returns {object} { shadow: [], checkpoint: [], ephemeral: [], discard: [], stats }
 */
function classifyBatch(messages, opts = {}) {
    const result = {
        shadow: [],     // HIGH value → save to shadow context
        checkpoint: [], // MEDIUM value → XRL checkpoint
        ephemeral: [],  // LOW value → live context only
        discard: [],    // ZERO value → discard
        stats: { high: 0, medium: 0, low: 0, zero: 0, totalChars: 0, savedChars: 0 }
    };

    for (const msg of messages) {
        const classification = classifyMessage(msg, opts);
        msg._retina = classification;

        const contentLen = typeof msg.content === 'string'
            ? msg.content.length
            : 0;

        result.stats.totalChars += contentLen;

        switch (classification.route) {
            case 'shadow':
                result.shadow.push(msg);
                result.stats.high++;
                break;
            case 'checkpoint':
                result.checkpoint.push(msg);
                result.stats.medium++;
                break;
            case 'ephemeral':
                result.ephemeral.push(msg);
                result.stats.low++;
                break;
            case 'discard':
                result.discard.push(msg);
                result.stats.zero++;
                result.stats.savedChars += contentLen; // chars saved by discarding
                break;
        }
    }

    return result;
}

// ── Gnist: Optional LLM-based retinal ganglion cell ─────────────────────────

/**
 * Create a gnist function that uses a local LLM to classify ambiguous messages.
 * The gnist is a tiny model — it fires only when the heuristic can't decide.
 *
 * @param {string} lmStudioUrl - LM Studio base URL
 * @param {string} model - Model name (should be tiny: 0.5B-1B)
 * @returns {function} gnistFn(content, context) → { value, reason }
 */
function createGnist(lmStudioUrl = 'http://127.0.0.1:7272', model = 'smart-router_gguf') {
    const fetch = globalThis.fetch || require('node-fetch');

    return async function gnistFn(content, context = {}) {
        // Only invoke for ambiguous cases (called by classifyMessage when score is 3-8)
        try {
            const res = await fetch(`${lmStudioUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model,
                    messages: [
                        {
                            role: 'system',
                            content: 'You are a retinal ganglion cell. Classify this message\'s value for long-term memory. Reply with EXACTLY one word: HIGH, MEDIUM, LOW, or ZERO. HIGH = code/decisions/errors/tasks. MEDIUM = questions/status. LOW = greetings/ack. ZERO = noise/filler.'
                        },
                        { role: 'user', content: content.slice(0, 500) }
                    ],
                    max_tokens: 5,
                    temperature: 0,
                    stream: false
                }),
                signal: AbortSignal.timeout(3000)
            });

            if (!res.ok) return null;
            const data = await res.json();
            const verdict = (data.choices?.[0]?.message?.content || '').trim().toUpperCase();

            if (verdict.includes('HIGH')) return { value: VALUE.HIGH, reason: 'gnist_high' };
            if (verdict.includes('MEDIUM')) return { value: VALUE.MEDIUM, reason: 'gnist_medium' };
            if (verdict.includes('LOW')) return { value: VALUE.LOW, reason: 'gnist_low' };
            if (verdict.includes('ZERO')) return { value: VALUE.ZERO, reason: 'gnist_zero' };
            return null;
        } catch (_) {
            return null; // gnist failure = fall back to heuristic
        }
    };
}

// ── Stats ───────────────────────────────────────────────────────────────────

/**
 * Get retina classification stats for a batch result.
 */
function formatStats(stats) {
    const total = stats.high + stats.medium + stats.low + stats.zero;
    return {
        total,
        distribution: {
            high:    `${stats.high} (${Math.round(stats.high / total * 100)}%)`,
            medium:  `${stats.medium} (${Math.round(stats.medium / total * 100)}%)`,
            low:     `${stats.low} (${Math.round(stats.low / total * 100)}%)`,
            zero:    `${stats.zero} (${Math.round(stats.zero / total * 100)}%)`
        },
        totalChars: stats.totalChars,
        savedChars: stats.savedChars,
        savedPct: stats.totalChars > 0 ? Math.round(stats.savedChars / stats.totalChars * 100) : 0
    };
}

// ── Export ─────────────────────────────────────────────────────────────────

module.exports = {
    VALUE,
    classifyMessage,
    classifyBatch,
    createGnist,
    formatStats,
    HIGH_SIGNALS,
    ZERO_SIGNALS,
    MEDIUM_SIGNALS
};