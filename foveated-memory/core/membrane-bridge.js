/**
 * ═══════════════════════════════════════════════════════
 * MEMBRANE BRIDGE — Node.js <-> Python Weaving Bridge
 * ═══════════════════════════════════════════════════════
 *
 * Spawns membrane_core.py to execute the LUMAX Membrane Balancer,
 * constructing a dynamic HUD containing turn counts, active checklist,
 * XRL codebase intuition, file edit diagnostics, and token budget pressure.
 */

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { getCachedSkeleton } = require('./skeleton-slimmer');

const PYTHON_BIN = process.env.PYTHON_PATH || 'python';
const MEMBRANE_CORE_PY = path.resolve(__dirname, '..', 'membrane_core.py');
const REPO_SKELETON_MD = path.resolve(__dirname, '..', 'repo-skeleton.md');

/**
 * Execute membrane_core.py via stdin/stdout JSON RPC.
 *
 * @param {object} payload
 * @returns {Promise<object>}
 */
function invokeMembraneCore(payload) {
    return new Promise((resolve) => {
        if (!fs.existsSync(MEMBRANE_CORE_PY)) {
            console.warn('[MembraneBridge] membrane_core.py not found at:', MEMBRANE_CORE_PY);
            return resolve(null);
        }

        const child = spawn(PYTHON_BIN, [MEMBRANE_CORE_PY], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let stdoutData = '';
        let stderrData = '';

        child.stdout.on('data', (chunk) => { stdoutData += chunk.toString(); });
        child.stderr.on('data', (chunk) => { stderrData += chunk.toString(); });

        child.on('close', (code) => {
            if (code !== 0) {
                console.warn(`[MembraneBridge] membrane_core.py exited with code ${code}:`, stderrData);
                return resolve(null);
            }
            try {
                const result = JSON.parse(stdoutData);
                resolve(result);
            } catch (err) {
                console.warn('[MembraneBridge] Failed to parse JSON from membrane_core.py:', err.message);
                resolve(null);
            }
        });

        child.on('error', (err) => {
            console.warn('[MembraneBridge] Failed to spawn Python:', err.message);
            resolve(null);
        });

        child.stdin.write(JSON.stringify(payload));
        child.stdin.end();
    });
}

/**
 * Load micro XRL repo skeleton for memory context
 */
function getRepoSkeletonSnippet() {
    try {
        // Use slim constellation map — auto-generated, cached, ~800 chars
        const skeletonRoot = path.resolve(__dirname, '..', '..');
        return getCachedSkeleton(skeletonRoot, REPO_SKELETON_MD).slice(0, 1500);
    } catch (_) {}
    return '';
}

/**
 * Weave context using membrane_core.py and construct the dynamic Agent HUD.
 *
 * @param {object} opts
 * @param {string} opts.redThread - Intent / main prompt
 * @param {number} opts.turnCount - Session turn count
 * @param {Array<string>} opts.clearedTasks - Cleared task list
 * @param {Array<string>} opts.pendingTasks - Pending task list
 * @param {Array<object>} opts.recentFileDiagnostics - Recent file edit pass/fail statuses
 * @param {number} opts.tokenBudget - Model token limit
 * @param {object} opts.backendInfo - Backend metadata (e.g. { model: '...' })
 * @returns {Promise<string>} Woven stream HUD string
 */
async function buildMembraneHUD(opts = {}) {
    const {
        redThread = 'AI Pair Programming Session',
        turnCount = 1,
        clearedTasks = [],
        pendingTasks = [],
        recentFileDiagnostics = [],
        tokenBudget = 8192,
        backendInfo = null,
    } = opts;

    // 1. Build HUD Red Thread string
    const clearedStr = clearedTasks.length > 0 ? clearedTasks.map(t => `  [x] ${t}`).join('\n') : '  (None cleared yet)';
    const pendingStr = pendingTasks.length > 0 ? pendingTasks.map(t => `  [ ] ${t}`).join('\n') : '  (No pending tasks)';
    
    let diagStr = '  (No recent file modifications)';
    if (recentFileDiagnostics.length > 0) {
        diagStr = recentFileDiagnostics.map(d => `  [${d.status === 'clean' ? 'PASSED 🟢' : 'FAILED 🔴'}] ${d.file}`).join('\n');
    }

    const hudHeader = `
[AGENT HUD & PROCESS TRACKER — TURN ${turnCount}]
STATUS & TASKS:
Cleared:
${clearedStr}
Pending:
${pendingStr}

RECENT FILE MODIFICATIONS:
${diagStr}

GOAL / INTENT:
${redThread}
`.trim();

    const repoSkeleton = getRepoSkeletonSnippet();

    const payload = {
        red_thread: hudHeader,
        skeleton: repoSkeleton ? `[XRL CODEBASE INTUITION]\n${repoSkeleton}` : '',
        tendrils: `[SERVICE PORTS] 8000:Soul, 8103:XRLF-Skeletonizer, 8109:Vectors, 8200:FoveatedMemory, 5176:WebXR`,
        token_budget: tokenBudget,
        backend_info: backendInfo
    };

    const result = await invokeMembraneCore(payload);
    if (result && result.merged_stream) {
        return result.merged_stream;
    }

    // Fallback: return un-woven HUD header if Python is unavailable
    return hudHeader;
}

module.exports = { buildMembraneHUD, invokeMembraneCore };
