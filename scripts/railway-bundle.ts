// Preserve the existing Railway Function image and runner; inline the versioned HTML.
const server=await Bun.file(new URL('../src/server.ts',import.meta.url)).text();
const html=await Bun.file(new URL('../public/index.html',import.meta.url)).text();
const bundled=server.replace('await Bun.file(new URL("../public/index.html",import.meta.url)).text()',JSON.stringify(html));
if(bundled===server)throw Error('Frontend entry point was not found');
await Bun.write(new URL('../artifacts/railway-start-command.txt',import.meta.url),'./run.sh '+Buffer.from(bundled).toString('base64'));
console.log('Railway startup bundle prepared. No deployment was performed.');
