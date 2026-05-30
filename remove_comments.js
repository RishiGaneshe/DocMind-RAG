import fs from 'fs';
import path from 'path';

function walkDir(dir, callback) {
    fs.readdirSync(dir).forEach(f => {
        const dirPath = path.join(dir, f);
        const isDirectory = fs.statSync(dirPath).isDirectory();
        isDirectory ? walkDir(dirPath, callback) : callback(path.join(dir, f));
    });
}

walkDir('./src', (filePath) => {
    if (filePath.endsWith('.js') || filePath.endsWith('.sql')) {
        let content = fs.readFileSync(filePath, 'utf8');
        
        if (filePath.endsWith('.js')) {
            // Remove single-line comments
            content = content.replace(/\/\/[^\n]*/g, '');
            // Remove multi-line comments
            content = content.replace(/\/\*[\s\S]*?\*\//g, '');
            // Remove semicolons
            content = content.replace(/;/g, '');
        } else if (filePath.endsWith('.sql')) {
            // Remove SQL single line comments
            content = content.replace(/--[^\n]*/g, '');
            // Remove semicolons
            content = content.replace(/;/g, '');
        }
        
        // Clean up multiple empty lines
        content = content.replace(/\n\s*\n/g, '\n\n');
        
        fs.writeFileSync(filePath, content.trim() + '\n', 'utf8');
    }
});
