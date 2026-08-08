/**
 * ═══════════════════════════════════════════════════════
 * XRL RECALL INTERCEPTOR
 * ═══════════════════════════════════════════════════════
 *
 * Monitors the LLM's streaming response for <recall: "..."> tokens.
 * When detected, it:
 *   1. Stops collecting the current (incomplete) response
 *   2. Searches the memory store for the query
 *   3. Injects a [MEMORY RECALLED] system message
 *   4. Re-invokes the LLM with a continuation prompt
 *   5. Returns the final (clean) response to the original client
 *
 * This module is stream-aware — it operates on SSE chunks.
 */

'use strict';

const RECALL_REGEX = /<recall:\s*"([^"]+)">/i;
const ZOOM_REGEX   = /<zoom:\s*"([^"]+)">/i;
const SACCADE_REGEX = /<saccade:\s*"([^"]+)">/i;
const ACCOMMODATE_REGEX = /<accommodate:\s*"([^"]+)">/i;

/**
 * Scan a text chunk for the <recall: "..."> token.
 * @param {string} text
 * @returns {string|null} The query string, or null if not found
 */
function detectRecall(text) {
    const m = text.match(RECALL_REGEX);
    return m ? m[1].trim() : null;
}

/**
 * Scan a text chunk for the <zoom: "..."> token.
 * The model emits this to request full-fidelity shadow context.
 * @param {string} text
 * @returns {string|null} The hash or search phrase, or null if not found
 */
function detectZoom(text) {
    const m = text.match(ZOOM_REGEX);
    return m ? m[1].trim() : null;
}

/**
 * Scan for <saccade: "..."> — model wants to move the fovea.
 * @param {string} text
 * @returns {string|null} The saccade target, or null
 */
function detectSaccade(text) {
    const m = text.match(SACCADE_REGEX);
    return m ? m[1].trim() : null;
}

/**
 * Scan for <accommodate: "..."> — model wants to sharpen/blur a region.
 * @param {string} text
 * @returns {string|null} The accommodation directive, or null
 */
function detectAccommodate(text) {
    const m = text.match(ACCOMMODATE_REGEX);
    return m ? m[1].trim() : null;
}

/**
 * Collect and buffer a full SSE streaming response.
 * Returns { fullText, rawChunks, recallQuery }
 *
 * Stops early if a recall token is detected mid-stream.
 *
 * @param {import('node-fetch').Response} upstreamResponse
 */
async function collectStream(upstreamResponse) {
    let fullText = '';
    const rawChunks = [];
    let buffer = '';

    return new Promise((resolve, reject) => {
        const body = upstreamResponse.body;
        if (!body) return resolve({ fullText: '', rawChunks: [], recallQuery: null });

        // Safety timeout: if stream hangs for >120s, resolve with what we have
        const hangTimer = setTimeout(() => {
            console.warn('[collectStream] ⚠️ Stream timeout (120s) — resolving with partial content');
            body.destroy();
            resolve({ fullText, rawChunks, recallQuery: detectRecall(fullText) });
        }, 120000);

        body.on('data', (chunk) => {
            const chunkStr = chunk.toString();
            rawChunks.push(chunkStr);
            buffer += chunkStr;

            // Process complete SSE lines from buffer
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';  // keep incomplete last line in buffer

            for (const line of lines) {
                if (!line.startsWith('data:')) continue;
                const data = line.slice(5).trim();
                if (data === '[DONE]') continue;
                try {
                    const parsed = JSON.parse(data);
                    const delta = parsed?.choices?.[0]?.delta || {};
                    const text = delta.content || delta.reasoning_content || delta.reasoning || '';
                    fullText += text;
                } catch (_) { /* partial chunk, ignore */ }
            }

            // Check for recall token mid-stream
            const recallQuery = detectRecall(fullText);
            if (recallQuery) {
                clearTimeout(hangTimer);
                body.destroy(); // Stop the upstream stream
                resolve({ fullText, rawChunks, recallQuery, zoomQuery: null, saccadeQuery: null, accommodateQuery: null });
            }
            // Check for zoom token mid-stream
            const zoomQuery = detectZoom(fullText);
            if (zoomQuery) {
                clearTimeout(hangTimer);
                body.destroy(); // Stop the upstream stream
                resolve({ fullText, rawChunks, recallQuery: null, zoomQuery, saccadeQuery: null, accommodateQuery: null });
            }
            // Check for saccade token mid-stream
            const saccadeQuery = detectSaccade(fullText);
            if (saccadeQuery) {
                clearTimeout(hangTimer);
                body.destroy();
                resolve({ fullText, rawChunks, recallQuery: null, zoomQuery: null, saccadeQuery, accommodateQuery: null });
            }
            // Check for accommodate token mid-stream
            const accommodateQuery = detectAccommodate(fullText);
            if (accommodateQuery) {
                clearTimeout(hangTimer);
                body.destroy();
                resolve({ fullText, rawChunks, recallQuery: null, zoomQuery: null, saccadeQuery: null, accommodateQuery });
            }
        });

        body.on('end', () => {
            clearTimeout(hangTimer);
            // Process any remaining buffered content
            if (buffer.startsWith('data:')) {
                const data = buffer.slice(5).trim();
                if (data && data !== '[DONE]') {
                    try {
                        const parsed = JSON.parse(data);
                        const delta = parsed?.choices?.[0]?.delta || {};
                        fullText += delta.content || delta.reasoning_content || delta.reasoning || '';
                    } catch (_) {}
                }
            }
            resolve({ fullText, rawChunks, recallQuery: detectRecall(fullText), zoomQuery: detectZoom(fullText), saccadeQuery: detectSaccade(fullText), accommodateQuery: detectAccommodate(fullText) });
        });
        body.on('error', reject);
    });
}

/**
 * Collect a non-streaming (JSON) response.
 * @param {import('node-fetch').Response} upstreamResponse
 */
async function collectJson(upstreamResponse) {
    const data = await upstreamResponse.json();
    const message = data?.choices?.[0]?.message || {};
    let fullText = message.content || '';
    // Ollama Cloud uses 'reasoning' instead of 'reasoning_content'.
    // If the model returned no content but has reasoning, surface it as content so the client sees a response.
    if (!fullText && message.reasoning_content) {
        fullText = message.reasoning_content;
    } else if (!fullText && message.reasoning) {
        fullText = message.reasoning;
    }
    if (data.choices?.[0]?.message) {
        data.choices[0].message.content = fullText;
    }
    const recallQuery = detectRecall(fullText);
    const zoomQuery = detectZoom(fullText);
    const saccadeQuery = detectSaccade(fullText);
    const accommodateQuery = detectAccommodate(fullText);
    return { fullText, data, recallQuery, zoomQuery, saccadeQuery, accommodateQuery };
}

/**
 * Build the [MEMORY RECALLED] injection block from search results.
 *
 * @param {string} query   - The recall query string
 * @param {Array}  results - Array of search result objects with message and score properties
 * @returns {string} The formatted memory injection block
 */
function buildMemoryInjection(query, results) {
    if (results.length === 0) {
        return `[MEMORY RECALLED for "${query}"]: No matching memories found.`;
    }

    const lines = results.map(r => {
        const ts = r.message.timestamp
            ? new Date(r.message.timestamp).toISOString().slice(0, 10)
            : '?';
        const role = (r.message.role || 'unknown').toUpperCase();
        const rawContent = r.message.content || '';
        const content = (Array.isArray(rawContent)
            ? rawContent.filter(p => p && typeof p.text === 'string').map(p => p.text).join('\n')
            : String(rawContent)
        ).trim();
        const score = (r.score * 100).toFixed(0);
        return `  [${ts}] ${role} (resonance ${score}%): ${content}`;
    });

    return `[MEMORY RECALLED for "${query}"]:\n${lines.join('\n')}`;
}

module.exports = { detectRecall, detectZoom, detectSaccade, detectAccommodate, collectStream, collectJson, buildMemoryInjection };
