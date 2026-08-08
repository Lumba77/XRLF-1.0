const fs = require('fs');
const path = require('path');
const { MemoryStore } = require('./memory/store');
const { v4: uuidv4 } = require('uuid');

const args = process.argv.slice(2);
if (args.length < 2) {
    console.log("Usage: node scan_and_ingest.js <workspace_id> <target_directory>");
    console.log("Example: node scan_and_ingest.js coding_bot ../../docs");
    console.log("\nThis tool safely scans a directory for markdown (.md) and text (.txt) files");
    console.log("and automatically imports them into the specified memory workspace.");
    process.exit(1);
}

const workspaceId = args[0];
const targetDir = path.resolve(args[1]);

if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    console.error(`❌ Target directory not found: ${targetDir}`);
    process.exit(1);
}

const store = new MemoryStore(path.resolve('./memory_data'), workspaceId);
let totalFilesScanned = 0;
let totalMemoriesImported = 0;

function scanDirectory(dir) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        // Skip node_modules and hidden folders for safety
        if (file === 'node_modules' || file.startsWith('.') || file === 'memory_data') continue;
        
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        
        if (stat.isDirectory()) {
            scanDirectory(fullPath);
        } else if (stat.isFile() && (file.endsWith('.md') || file.endsWith('.txt'))) {
            totalFilesScanned++;
            processFile(fullPath);
        }
    }
}

function processFile(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    // Safety check: Don't ingest massive files (>1MB) to prevent DB bloat
    if (content.length > 1024 * 1024) {
        console.warn(`[SKIPPED] ${filePath} is too large (>1MB).`);
        return;
    }

    const paragraphs = content.split(/\n\s*\n/);
    const sessionId = 'autoscan-' + uuidv4().slice(0, 8);
    let count = 0;

    for (const p of paragraphs) {
        const text = p.trim();
        // Ignore code blocks or very short lines
        if (text.length > 20 && !text.startsWith('```')) {
            store.store(sessionId, 'system', `[Source: ${path.basename(filePath)}]\n${text}`, new Date().toISOString());
            count++;
            totalMemoriesImported++;
        }
    }
    console.log(`[IMPORTED] ${path.basename(filePath)} -> ${count} knowledge blocks extracted.`);
}

console.log(`\n🔍 Scanning ${targetDir} for documents...`);
scanDirectory(targetDir);

setTimeout(() => {
    store.count().then(n => {
        console.log(`\n✅ Scan Complete!`);
        console.log(`   Scanned: ${totalFilesScanned} documents`);
        console.log(`   Imported: ${totalMemoriesImported} new knowledge blocks`);
        console.log(`   Workspace [${workspaceId}] now holds ${n} total memories.\n`);
        process.exit(0);
    });
}, 2000);
