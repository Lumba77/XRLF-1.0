/**
 * ═══════════════════════════════════════════════════════
 * CODE PRESERVATION SCHEMA
 * ═══════════════════════════════════════════════════════
 *
 * Extracts protected code structures from messages BEFORE the
 * proxy pipeline (stripThinking, compressContext, smartRouter,
 * applyBudget) and restores them AFTER — ensuring critical
 * code, schemas, and tool definitions survive intact.
 *
 * How it works:
 *   1. SCAN  — Find all protected regions in messages
 *   2. EXTRACT — Store each region by content hash
 *   3. REPLACE — Swap regions with [PRESERVED:hash:type] tokens
 *   4. PROCESS — Run the normal proxy pipeline (stripping, compression)
 *   5. RESTORE — Swap tokens back to original content
 *
 * Protected structures (configurable):
 *   - Code fences (```...```)
 *   - Thinking blocks (<thinking>...</thinking>)
 *   - JSON schemas / structured objects
 *   - Tool call definitions
 *   - XML/HTML blocks
 *   - Function signatures
 *   - Custom regex patterns
 */

'use strict';

const crypto = require('crypto');

// ── Preservation Schema ────────────────────────────────────────────────────

/**
 * Each entry defines a type of structure to preserve.
 * @typedef {object} PreservationRule
 * @property {string}   name        - Human-readable name for logging
 * @property {RegExp}   pattern     - Regex to match the structure (must have capture groups)
 * @property {number}   priority    - Higher = processed first (to avoid nested conflicts)
 * @property {boolean}   enabled     - Whether this rule is active
 * @property {number}   minLength   - Minimum content length to preserve (skip tiny matches)
 * @property {function} [extract]   - Optional: custom extractor fn(match) => content
 */

const DEFAULT_RULES = [
    {
        name: 'code_fence',
        pattern: /```(\w*)\n([\s\S]*?)```/g,
        priority: 100,
        enabled: true,
        minLength: 20,
        extract: (match) => match[0]  // preserve the full fence including backticks
    },
    {
        name: 'thinking_block',
        pattern: /<thinking>([\s\S]*?)<\/thinking>/gi,
        priority: 90,
        enabled: true,
        minLength: 10,
        extract: (match) => match[0]  // preserve the full <thinking>...</thinking>
    },
    {
        name: 'json_object',
        pattern: /(?<![\w`])(\{[\s\S]*?"[\w]+"[\s\S]*?\})(?![\s]*[`])(?=\s*(?:$|\n\n|\n(?:[A-Z]|```|[-*])))/g,
        priority: 80,
        enabled: true,
        minLength: 50,
        extract: (match) => match[1] || match[0]
    },
    {
        name: 'tool_call_xml',
        pattern: /(<function_calls>[\s\S]*?<\/function_calls>)/gi,
        priority: 85,
        enabled: true,
        minLength: 20,
        extract: (match) => match[0]
    },
    {
        name: 'xml_block',
        pattern: /(<(?:instructions|system|context|memory|recall|schema|config)[^>]*>[\s\S]*?<\/\1>)/gi,
        priority: 70,
        enabled: true,
        minLength: 30,
        extract: (match) => match[0]
    },
    {
        name: 'inline_code',
        pattern: /`([^`]{20,})`/g,
        priority: 50,
        enabled: true,
        minLength: 20,
        extract: (match) => match[0]
    },
    {
        name: 'function_signature',
        pattern: /(?:^|\n)((?:async\s+)?(?:function\s+\w+|(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\([^)]*\)\s*=>)\s*\{[\s\S]*?\n\})(?=\n|$)/gm,
        priority: 60,
        enabled: false,  // disabled by default — too aggressive
        minLength: 30,
        extract: (match) => match[0]
    },

    // ── Crucial Context Rules ──────────────────────────────────────────
    // These protect context anchors that must survive ALL compression.
    // Without these, the model loses its task thread, goals, and decisions.

    {
        name: 'task_board',
        pattern: /(\[ACTIVE TASK BOARD[\s\S]*?(?:\n>.*|\n$|\n(?=\[)))/gi,
        priority: 110,
        enabled: true,
        minLength: 15,
        extract: (match) => match[0]
    },
    {
        name: 'todo_list',
        pattern: /((?:^|\n)((?:\s*[-*]\s+\[[ xX]\]\s+.+\n?){2,}))/gm,
        priority: 108,
        enabled: true,
        minLength: 15,
        extract: (match) => match[0].trim()
    },
    {
        name: 'agent_hud',
        pattern: /(\[AGENT HUD[\s\S]*?(?:\n━━━|\n$|\n(?=\[)))/gi,
        priority: 105,
        enabled: true,
        minLength: 20,
        extract: (match) => match[0]
    },
    {
        name: 'red_thread',
        pattern: /(GOAL\s*\/\s*INTENT:\s*\n[\s\S]*?(?:\n\n|\n(?=\[)|$))/gi,
        priority: 103,
        enabled: true,
        minLength: 10,
        extract: (match) => match[0]
    },
    {
        name: 'decision_log',
        pattern: /(DECISIONS?:\s*[^\n]*(?:\n(?:[A-Z][^:]*:\s*[^\n]*))*)/gi,
        priority: 102,
        enabled: true,
        minLength: 15,
        extract: (match) => match[0]
    },
    {
        name: 'file_edit_status',
        pattern: /(RECENT FILE MODIFICATIONS:\s*\n(?:\s+\[[^\]]+\]\s+.+\n?)+)/gi,
        priority: 101,
        enabled: true,
        minLength: 15,
        extract: (match) => match[0]
    },
    {
        name: 'error_diagnosis',
        pattern: /((?:ERROR|DIAGNOSIS|ROOT CAUSE|FIX)[:\s][^\n]*(?:\n(?:\s+.+|[A-Z][^:]*:.+))*)/gi,
        priority: 100,
        enabled: true,
        minLength: 20,
        extract: (match) => match[0]
    },
    {
        name: 'current_mode',
        pattern: /(Current Mode\s*\n<slug>[^<]*<\/slug>\s*\n<name>[^<]*<\/name>\s*\n<model>[^<]*<\/model>)/gi,
        priority: 99,
        enabled: true,
        minLength: 20,
        extract: (match) => match[0]
    },
    {
        name: 'system_directives',
        pattern: /(\[(?:SYSTEM|CONTINUOUS WORK STREAK|FOVEATED MEMORY SYSTEM)[^\]]*\][\s\S]*?(?:\n\n|\n(?=\[)|$))/gi,
        priority: 98,
        enabled: true,
        minLength: 30,
        extract: (match) => match[0]
    }
];

// ── State ───────────────────────────────────────────────────────────────────

/** @type {Map<string, {content: string, type: string, timestamp: string}>} */
const preservationStore = new Map();

/** @type {PreservationRule[]} */
let activeRules = [...DEFAULT_RULES];

// ── Configuration ───────────────────────────────────────────────────────────

/**
 * Load custom preservation rules from config.
 * Merges with defaults — custom rules with same name override defaults.
 */
function configure(customRules = []) {
    const merged = [...DEFAULT_RULES];
    for (const custom of customRules) {
        const idx = merged.findIndex(r => r.name === custom.name);
        if (idx >= 0) {
            merged[idx] = { ...merged[idx], ...custom };
        } else {
            merged.push(custom);
        }
    }
    activeRules = merged.filter(r => r.enabled !== false);
    activeRules.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    console.log(`[CodePreserver] Configured with ${activeRules.length} active rules: ${activeRules.map(r => r.name).join(', ')}`);
}

/**
 * Enable/disable a specific rule by name.
 */
function setRuleEnabled(name, enabled) {
    const rule = activeRules.find(r => r.name === name);
    if (rule) {
        rule.enabled = enabled;
        console.log(`[CodePreserver] Rule '${name}' ${enabled ? 'enabled' : 'disabled'}`);
    }
    // Also update in DEFAULT_RULES for persistence
    const defRule = DEFAULT_RULES.find(r => r.name === name);
    if (defRule) defRule.enabled = enabled;
}

// ── Core: Extract & Replace ─────────────────────────────────────────────────

/**
 * Generate a stable hash for content.
 */
function generateHash(content) {
    return crypto.createHash('sha256').update(content).digest('hex').substring(0, 12);
}

/**
 * Extract protected regions from text using active rules.
 * Returns { cleanedText: string with [PRESERVED:hash:type] tokens, preserved: Map of hash->{content, type} }
 */
function extractFromText(text, rules = activeRules) {
    const preserved = new Map();
    let cleanedText = text;

    // Sort rules by priority (higher first)
    const sortedRules = [...rules].sort((a, b) => (b.priority || 0) - (a.priority || 0));

    for (const rule of sortedRules) {
        if (!rule.enabled) continue;

        let match;
        const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
        
        while ((match = regex.exec(cleanedText)) !== null) {
            const content = rule.extract ? rule.extract(match) : match[0];
            
            // Skip if too short
            if (content.length < (rule.minLength || 0)) continue;

            const hash = generateHash(content);
            const type = rule.name;

            // Store preserved content
            preserved.set(hash, { content, type, timestamp: new Date().toISOString() });

            // Replace with token
            const token = `[PRESERVED:${hash}:${type}]`;
            cleanedText = cleanedText.replace(match[0], token);

            // Reset regex last index to avoid infinite loop
            regex.lastIndex = 0;
        }
    }

    return { cleanedText, preserved };
}

/**
 * Restore preserved content from tokens back to original.
 */
function restoreToText(text, store = preservationStore) {
    let restored = text;

    for (const [hash, entry] of store) {
        const token = `[PRESERVED:${hash}:${entry.type}]`;
        restored = restored.replace(token, entry.content);
    }

    return restored;
}

// ── Message-Level API ───────────────────────────────────────────────────────

/**
 * Extract protected regions from an array of messages.
 * Returns { messages: cleaned messages, store: Map of preserved content }
 *
 * @param {Array<object>} messages - OpenAI-format messages array
 * @param {PreservationRule[]} rules - Custom preservation rules (uses activeRules if not provided)
 * @returns {{ messages: Array, store: Map }}
 */
function extractFromMessages(messages, rules) {
    if (!Array.isArray(messages)) return { messages, store: new Map() };

    const effectiveRules = rules || activeRules;
    const globalStore = new Map();
    const cleanedMessages = messages.map(msg => {
        if (typeof msg.content === 'string') {
            const { cleanedText, preserved } = extractFromText(msg.content, effectiveRules);
            // Merge into global store
            for (const [hash, entry] of preserved) {
                globalStore.set(hash, entry);
            }
            return { ...msg, content: cleanedText };
        } else if (Array.isArray(msg.content)) {
            // Multimodal content — preserve text parts only
            const cleanedParts = msg.content.map(part => {
                if (part.type === 'text' && typeof part.text === 'string') {
                    const { cleanedText, preserved } = extractFromText(part.text, effectiveRules);
                    for (const [hash, entry] of preserved) {
                        globalStore.set(hash, entry);
                    }
                    return { ...part, text: cleanedText };
                }
                return part;
            });
            return { ...msg, content: cleanedParts };
        }
        return msg;
    });

    // Also store in the module-level preservationStore for cross-request access
    for (const [hash, entry] of globalStore) {
        preservationStore.set(hash, entry);
    }

    return { messages: cleanedMessages, store: globalStore };
}

/**
 * Restore preserved content back into messages.
 *
 * @param {Array<object>} messages - Messages that may contain preservation tokens
 * @param {Map} store - The preservation store (from extractFromMessages, uses preservationStore if not provided)
 * @returns {Array<object>} - Messages with original content restored
 */
function restoreToMessages(messages, store) {
    if (!Array.isArray(messages)) return messages;
    const effectiveStore = store || preservationStore;

    return messages.map(msg => {
        if (typeof msg.content === 'string') {
            return { ...msg, content: restoreToText(msg.content, effectiveStore) };
        } else if (Array.isArray(msg.content)) {
            return {
                ...msg,
                content: msg.content.map(part => {
                    if (part.type === 'text' && typeof part.text === 'string') {
                        return { ...part, text: restoreToText(part.text, effectiveStore) };
                    }
                    return part;
                })
            };
        }
        return msg;
    });
}

// ── Export API ───────────────────────────────────────────────────────────────

module.exports = {
    configure,
    setRuleEnabled,
    extractFromText,
    restoreToText,
    extractFromMessages,
    restoreToMessages,
    preservationStore,
    DEFAULT_RULES
};
