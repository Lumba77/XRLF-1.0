const fs = require('fs');
const path = require('path');
const { MemoryStore } = require('./memory/store');

const args = process.argv.slice(2);
if (args.length < 1) {
    console.log("Usage:");
    console.log("  node manage_memory.js workspaces              (List all active workspaces)");
    console.log("  node manage_memory.js list <workspace_id>     (View recent entries in a workspace)");
    console.log("  node manage_memory.js clear <workspace_id>    (WIPE all memory for a workspace)");
    process.exit(1);
}

const action = args[0];
const workspaceId = args[1] || 'default';
const persistPath = path.resolve('./memory_data');

async function run() {
    if (action === 'workspaces') {
        if (!fs.existsSync(persistPath)) {
            console.log("No memory databases found.");
            return;
        }
        const folders = fs.readdirSync(persistPath).filter(f => fs.statSync(path.join(persistPath, f)).isDirectory());
        console.log(`\n🧠 Active Memory Workspaces (${folders.length}):`);
        for (const folder of folders) {
            const store = new MemoryStore(persistPath, folder);
            const count = await store.count();
            console.log(`  - [${folder}]: ${count} memories stored`);
        }
    } 
    else if (action === 'list') {
        const store = new MemoryStore(persistPath, workspaceId);
        const total = await store.count();
        console.log(`\n🧠 Workspace [${workspaceId}] has ${total} entries. Showing 10 most recent:\n`);
        
        const recent = await store.getRecent(10);
        recent.forEach((msg, idx) => {
            console.log(`[${idx+1}] [${msg.timestamp}] ${msg.role.toUpperCase()}:`);
            const raw = msg.content;
            const text = Array.isArray(raw)
                ? raw.filter(p => p && typeof p.text === 'string').map(p => p.text).join('\n')
                : String(raw || '');
            console.log(`    ${text.substring(0, 150).replace(/\n/g, ' ')}...`);
            console.log(`    (ID: ${msg._id})\n`);
        });
    }
    else if (action === 'clear') {
        const store = new MemoryStore(persistPath, workspaceId);
        const removed = await store.clearAll();
        console.log(`\n🧹 WIPED: Removed ${removed} memory entries from workspace [${workspaceId}].`);
    }
    else {
        console.error("Unknown command.");
    }
}

run();
