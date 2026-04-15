const fs = require('fs');
const path = require('path');

function walk(dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach(file => {
        file = path.join(dir, file);
        const stat = fs.statSync(file);
        if (stat && stat.isDirectory()) { 
            results = results.concat(walk(file));
        } else { 
            if (file.endsWith('.tsx')) results.push(file);
        }
    });
    return results;
}

const files = walk('src/components');
let total = 0;

files.forEach(f => {
    let c = fs.readFileSync(f, 'utf8');
    
    // Careful replace
    const newC = c.replace(/fixed inset-0/g, 'fixed top-[var(--safe-area-top,0px)] right-0 bottom-0 left-0');
    
    if (c !== newC) {
        fs.writeFileSync(f, newC);
        console.log('Replaced in', f);
        total++;
    }
});

console.log('Total fixed inset-0 replacements:', total);
