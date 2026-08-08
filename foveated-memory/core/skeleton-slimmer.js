/**
 * ═══════════════════════════════════════════════════════
 * SKELETON SLIMMER — Constellation Map Generator
 * ═══════════════════════════════════════════════════════
 *
 * Generates a slim repo skeleton that fits in the 4K context budget.
 * It's a constellation map — general structure only, no compiled bones.
 *
 * The model doesn't need full file contents in the skeleton because it can
 * always <zoom:> or <saccade:> to retrieve full files from shadow context.
 *
 * Strategy:
 *   - List directories (max depth 2-3)
 *   - Show file names only (no contents)
 *   - Skip noise: node_modules, .git, dist, build, __pycache__, .sidecar
 *   - Skip binary/compiled: .gguf, .safetensors, .onnx, .whl, .db
 *   - Skip large files: > 50KB
 *   - Annotate key files with one-line purpose (from first comment)
 *   - Cap total output at SKELETON_MAX_CHARS (default 800 — fits 4K budget)
 *
 * Output format:
 *   project-root/
 *     api/          — REST endpoints
 *       server.py   — OpenAI-compatible proxy server
 *     core/         — proxy pipeline modules
 *       retina.js   — value classifier
 *       ...
 *     (12 files, 8 dirs — 23 skipped as noise)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────────────

const SKELETON_MAX_CHARS  = parseInt(process.env.XRLF_SKELETON_MAX_CHARS  || '800', 10);
const SKELETON_MAX_DEPTH  = parseInt(process.env.XRLF_SKELETON_MAX_DEPTH  || '3',   10);
const SKELETON_MAX_FILES  = parseInt(process.env.XRLF_SKELETON_MAX_FILES  || '60',  10);
const SKELETON_MAX_ANNOT = parseInt(process.env.XRLF_SKELETON_MAX_ANNOT  || '40',  10);

// Directories to skip entirely
const SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', '__pycache__', '.sidecar',
    '.cache', 'memory_data', 'checkpoints', 'shadow-context',
    '.codersinflow', '.claude', 'venv', '.venv', 'env',
    'target', 'bin', 'obj', '.next', '.nuxt', 'coverage'
]);

// File extensions to skip (binary/compiled/large)
const SKIP_EXTENSIONS = new Set([
    '.gguf', '.safetensors', '.onnx', '.whl', '.db', '.db-journal',
    '.pyc', '.pyo', '.class', '.jar', '.war', '.wasm',
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp',
    '.mp3', '.mp4', '.wav', '.avi', '.mov', '.webm',
    '.zip', '.tar', '.gz', '.rar', '.7z',
    '.exe', '.dll', '.so', '.dylib', '.lib', '.a', '.o',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx',
    '.gguf', '.bin', '.pt', '.pth', '.ckpt', '.gguf'
]);

// Files to always skip (noise)
const SKIP_FILES = new Set([
    '.DS_Store', 'Thumbs.db', '.gitignore', '.gitattributes',
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
    '.env', '.env.local', '.env.example'
]);

// Key files worth annotating (show first comment line as purpose)
const ANNOTATE_EXTENSIONS = new Set([
    '.py', '.js', '.ts', '.jsx', '.tsx', '.json', '.yaml', '.yml',
    '.md', '.html', '.css', '.sh', '.bat', '.ps1'
]);

// ── Core: Build Slim Skeleton ───────────────────────────────────────────────

/**
 * Extract a one-line purpose annotation from a file's first comment.
 * Only reads the first 500 bytes — no full file reads.
 */
function extractAnnotation(filePath) {
    try {
        const fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(500);
        const bytes = fs.readSync(fd, buf, 0, 500, 0);
        fs.closeSync(fd);
        const text = buf.slice(0, bytes).toString('utf8');

        // Python: # comment
        const pyMatch = text.match(/^#\s*(.+)/m);
        if (pyMatch) return pyMatch[1].trim().slice(0, ANNOTATE_MAX_ANNOT);

        // JS/TS: // or /** */ comment
        const jsMatch = text.match(/^(?:\/\/| \*|\/\*\*)\s*(.+)/m);
        if (jsMatch) return jsMatch[1].trim().replace(/\*\//, '').slice(0, ANNOTATE_MAX_ANNOT);

        // YAML/JSON: no annotation
        return null;
    } catch (_) {
        return null;
    }
}

/**
 * Check if a file should be skipped.
 */
function shouldSkipFile(name, stat) {
    if (SKIP_FILES.has(name)) return true;
    const ext = path.extname(name).toLowerCase();
    if (SKIP_EXTENSIONS.has(ext)) return true;
    // Skip files larger than 50KB
    if (stat.size > 50 * 1024) return true;
    return false;
}

/**
 * Recursively scan a directory and build the skeleton tree.
 *
 * @param {string} dir - Directory to scan
 * @param {number} depth - Current depth
 * @param {number} indent - Indent level for output
 * @param {object} state - { lines, fileCount, dirCount, skippedCount, chars }
 * @returns {void}
 */
function scanDir(dir, depth, indent, state) {
    if (depth > SKELETON_MAX_DEPTH) return;
    if (state.fileCount >= SKELETON_MAX_FILES) return;
    if (state.chars >= SKELETON_MAX_CHARS) return;

    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) { return; }

    // Sort: directories first, then files, alphabetically
    entries.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
        if (state.chars >= SKELETON_MAX_CHARS) break;
        if (state.fileCount >= SKELETON_MAX_FILES) break;

        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) {
                state.skippedCount++;
                continue;
            }

            state.dirCount++;
            const prefix = '  '.repeat(indent);
            const line = `${prefix}${entry.name}/`;
            state.lines.push(line);
            state.chars += line.length + 1;

            scanDir(fullPath, depth + 1, indent + 1, state);
        } else if (entry.isFile()) {
            let stat;
            try { stat = fs.statSync(fullPath); } catch (_) { continue; }

            if (shouldSkipFile(entry.name, stat)) {
                state.skippedCount++;
                continue;
            }

            state.fileCount++;
            const prefix = '  '.repeat(indent);
            let line = `${prefix}${entry.name}`;

            // Annotate key files with one-line purpose
            const ext = path.extname(entry.name).toLowerCase();
            if (ANNOTATE_EXTENSIONS.has(ext) && state.chars < SKELETON_MAX_CHARS - 100) {
                const annot = extractAnnotation(fullPath);
                if (annot && annot.length > 3) {
                    line += `  — ${annot}`;
                }
            }

            state.lines.push(line);
            state.chars += line.length + 1;
        }
    }
}

/**
 * Generate a slim repo skeleton string.
 *
 * @param {string} rootDir - Root directory to scan (defaults to workspace root)
 * @returns {string} The skeleton constellation map
 */
function generateSkeleton(rootDir) {
    if (!rootDir) {
        rootDir = path.resolve(__dirname, '..', '..');
    }

    const state = {
        lines: [],
        fileCount: 0,
        dirCount: 0,
        skippedCount: 0,
        chars: 0
    };

    const rootName = path.basename(rootDir) || 'project-root';
    state.lines.push(`${rootName}/`);
    state.chars += rootName.length + 2;

    scanDir(rootDir, 1, 1, state);

    // Add summary footer
    const summary = `(${state.fileCount} files, ${state.dirCount} dirs — ${state.skippedCount} skipped as noise)`;
    state.lines.push(summary);

    return state.lines.join('\n');
}

/**
 * Generate and cache the skeleton to disc.
 * The skeleton is regenerated only if the cache is older than CACHE_TTL ms
 * or if the file doesn't exist.
 *
 * @param {string} rootDir
 * @param {string} cachePath
 * @returns {string} The skeleton string
 */
function getCachedSkeleton(rootDir, cachePath) {
    if (!cachePath) {
        cachePath = path.resolve(__dirname, '..', 'repo-skeleton.md');
    }

    const CACHE_TTL = parseInt(process.env.XRLF_SKELETON_CACHE_TTL || '300000', 10); // 5 min default

    try {
        if (fs.existsSync(cachePath)) {
            const stat = fs.statSync(cachePath);
            const age = Date.now() - stat.mtimeMs;
            if (age < CACHE_TTL) {
                return fs.readFileSync(cachePath, 'utf8');
            }
        }
    } catch (_) {}

    // Regenerate
    const skeleton = generateSkeleton(rootDir);
    try {
        fs.writeFileSync(cachePath, skeleton, 'utf8');
    } catch (_) {}

    return skeleton;
}

// ── Export ─────────────────────────────────────────────────────────────────

module.exports = {
    generateSkeleton,
    getCachedSkeleton,
    extractAnnotation,
    SKIP_DIRS,
    SKIP_EXTENSIONS
};
