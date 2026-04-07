const fs = require('fs');

const config = `window.SUPABASE_URL = "${process.env.SUPABASE_URL}";
window.SUPABASE_KEY = "${process.env.SUPABASE_KEY}";`;

fs.writeFileSync('config.js', config);
console.log('config.js generated');