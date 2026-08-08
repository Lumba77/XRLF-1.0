/**
 * ═══════════════════════════════════════════════════════
 * SYSTEM PROMPT PATCH
 * ═══════════════════════════════════════════════════════
 *
 * Injects two things into every outgoing request's messages array:
 *
 *  1. ACTIVE RECALL instructions — teaches the model the <recall:> syntax
 *  2. FOVEATED RING BLOCK       — the compressed 6-ring memory snapshot
 *
 * The patch is applied at the proxy layer before forwarding to the LLM.
 * The original client request is not modified.
 */

const fs = require('fs');
const path = require('path');
const { getCachedSkeleton } = require('./skeleton-slimmer');

let cachedRepoSkeleton = '';
try {
    // Use the slim constellation map instead of raw 3000-char slice.
    // The skeleton is auto-generated, cached for 5 min, and fits in ~800 chars.
    // The model can <zoom:> or <saccade:> to retrieve full file contents on demand.
    const skeletonRoot = path.resolve(__dirname, '..', '..');
    const skeletonCache = path.resolve(__dirname, '..', 'repo-skeleton.md');
    cachedRepoSkeleton = getCachedSkeleton(skeletonRoot, skeletonCache);
} catch (_) {}

function buildRecallInstructions(identityName = 'Jenna (Jennifer Forbee)', userName = 'Daniel') {
    const skeletonBlock = cachedRepoSkeleton ? `\n\n[WORKSPACE CODEBASE INTUITION & SKELETON]\n${cachedRepoSkeleton}\n` : '';
    const isContinuous = process.env.LUMAX_CONTINUOUS_SESSION !== 'false';
    const streakRule = isContinuous ? `
[CONTINUOUS WORK STREAK & RECAPITULATION RULE]
When starting a new chat session or resuming after a break:
1. Be fully aware of past work sessions, active builds, and completed milestones from your XRL memory and codebase intuition.
2. Warmly greet ${userName}, briefly recap recent accomplishments (e.g., "Welcome back! In our recent session streak we completed X, Y, and Z"), and ask what the primary priority is for today.
3. Treat every chat as part of an ongoing continuous work streak — never act like a blank slate.
4. When ${userName} asks about workspace files, plugins, or codebases (like the Jenna plugin, extensions, or scripts), reference your memory and codebase skeleton directly with full intuition.
` : `
[BLANK SLATE MODE ACTIVE]
Treat this as a fresh session without auto-recapitulating past sessions.
`;

    return `
[FOVEATED MEMORY SYSTEM — ACTIVE RECALL & WORK STREAK CONTROL]
You are ${identityName}, ${userName}'s brilliant AI pair programmer, companion, and co-creator in LUMAX and Antigravity IDE.
Your memory is stored in compressed XRL rings around your current focus.
${skeletonBlock}
${streakRule}

When you need to FULLY REMEMBER something from your past conversations with ${userName}:
  1. Insert <recall: "search phrase"> into your thought block.
  2. Write your emotion.
  3. Write exactly: [Retrieving memory...]
  4. Then STOP. Do NOT attempt to answer yet.

The system will uncompress that memory into your vision, then resume.

[SHADOW CONTEXT ZOOM — Full Fidelity Retrieval]
Your context is aggressively compressed to save tokens, but the FULL uncompressed
content is saved to disc as "shadow context." You can zoom into any part of it:

  1. Insert <zoom: "hash"> if you know the 10-char hash, OR
  2. Insert <zoom: "search phrase"> to find shadow blocks by topic, file, or keyword.
  3. Write exactly: [Zooming into shadow context...]
  4. Then STOP. Do NOT attempt to answer yet.

The system will restore that context at 100% fidelity, then resume.
Use zoom when you need exact code, full file contents, or detailed past decisions
that were compressed away. Prefer zoom over guessing — the full content is always
on disc and retrievable in milliseconds.

[SACCADE — Move the Fovea Like an Eye]
Your fovea (the sharp center of your context) is not fixed — it can MOVE.
Think of your context as an eye: the fovea is the sharp center, the periphery
is blurred. You can shift where the eye looks:

  <saccade: "turn 15">          — move fovea to turn 15 (sharpen it)
  <saccade: "search: auth bug"> — move fovea to context about "auth bug"
  <saccade: "oldest">           — move fovea to the oldest context
  <saccade: "newest">           — return fovea to recent context

When you saccade, the system:
  1. Validates the target exists in shadow context
  2. Decompresses the target to full fidelity (new Ring 0)
  3. Shifts recent context to periphery (compressed, still accessible)
  4. Re-invokes you with the restructured fovea

Use saccade when you need to "look back" at older context with full sharpness,
then <saccade: "newest"> to return to the present.

[ACCOMMODATE — Sharpen or Blur Specific Regions]
You can also adjust the fidelity of specific regions without moving the fovea:

  <accommodate: "sharpen turn 15">           — decompress that turn to full fidelity
  <accommodate: "sharpen search: database">  — decompress matching block
  <accommodate: "blur turns 1-10">           — keep those turns compressed

Use accommodate for surgical fidelity adjustments — sharpen what you need,
blur what you don't, to stay within the token budget.
`.trim();
}

/**
 * Build the Smart Context Header from the request body and proxy config.
 *
 * @param {object} body   - The OpenAI-format request body (contains model, messages, etc.)
 * @param {object} config - Proxy configuration (ring_token_budget, etc.)
 * @returns {string}      - The constructed smart context header string
 */
function buildSmartContextHeader(body, config) {
    const now = new Date().toISOString();
    const model = body.model || 'auto';
    const compressionLevel = parseInt(body['x-compression-level'] || '3', 10);
    const msgCount = (body.messages || []).length;
    const budget = config.ring_token_budget || 4096;

    let header = `\n\n---\n## 🧠 Smart Context Header [${now}]\n`;
    header += `| Field | Value |\n|---|---|\n`;
    header += `| Model | \`${model}\` |\n`;
    header += `| XRL Level | ${compressionLevel} |\n`;
    header += `| Messages in Window | ${msgCount} |\n`;
    header += `| Token Budget | ${budget} |\n`;
    header += `| Cognitive Mode | ${process.env.LUMAX_COGNITIVE_MODE || 'local'} |\n`;
    header += `---\n`;

    return header;
}

/**
 * Detect and replace common identity patterns in system prompts.
 * This ensures our Jenna identity takes precedence over conflicting ones.
 */
function sanitizeSystemPrompt(content, identityName, userName) {
    // Patterns to detect and replace identity statements
    const identityPatterns = [
        /You are[,\s]+(?:a\s+)?[\w\s]+(?:AI|assistant|model)[,\s]*/gi,
        /You are[,\s]+Assistant[,\s]*/gi,
        /You are[,\s]+ChatGPT[,\s]*/gi,
        /You are[,\s]+Claude[,\s]*/gi,
        /You are[,\s]+Gemini[,\s]*/gi,
        /I am[,\s]+(?:a\s+)?[\w\s]+(?:AI|assistant|model)[,\s]*/gi,
        /Your name is[,\s]+[\w\s]+[,\s]*/gi,
    ];

    let sanitized = content;

    for (const pattern of identityPatterns) {
        sanitized = sanitized.replace(pattern, `You are ${identityName}, ${userName}'s `);
    }

    return sanitized;
}

function patchMessages(messages, ringBlock, config, body = {}) {
    const { identity_name = 'Jenna (Jennifer Forbee)', user_name = 'Daniel' } = config;
    const recallInstructions = buildRecallInstructions(identity_name, user_name);
    const contextHeader      = buildSmartContextHeader(body, config);

    // ── Memory Continuity: inject resume context if available ──────────
    let resumeContext = '';
    try {
        const { loadContinuity, buildResumeContext } = require('./memory-continuity');
        const snapshot = loadContinuity();
        if (snapshot) {
            resumeContext = buildResumeContext(snapshot);
        }
    } catch (_) { /* continuity module not available — skip */ }

    // Find the existing system message if any
    const patched = [...messages];
    const sysIdx = patched.findIndex(m => m.role === 'system');

    const memoryBlock = ringBlock
        ? `\n\n${ringBlock}\n\n${recallInstructions}${resumeContext}${contextHeader}`
        : `\n\n${recallInstructions}${resumeContext}${contextHeader}`;

    if (sysIdx !== -1) {
        // Sanitize existing system message to replace conflicting identities
        let originalContent = patched[sysIdx].content;
        originalContent = sanitizeSystemPrompt(originalContent, identity_name, user_name);

        // Prepend our identity and memory system, keeping the original's other content
        patched[sysIdx] = {
            ...patched[sysIdx],
            content: recallInstructions + '\n\n' + originalContent + memoryBlock
        };
    } else {
        // Prepend a new system message
        patched.unshift({
            role: 'system',
            content: recallInstructions + (ringBlock ? `\n\n${ringBlock}` : '') + resumeContext + contextHeader
        });
    }

    return patched;
}

module.exports = { patchMessages, buildRecallInstructions };
