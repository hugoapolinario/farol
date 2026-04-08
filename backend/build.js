const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const config = `window.SUPABASE_URL = "${process.env.SUPABASE_URL}";
window.SUPABASE_KEY = "${process.env.SUPABASE_KEY}";`;

fs.writeFileSync(path.join(root, 'config.js'), config);
console.log('config.js generated at repo root');
