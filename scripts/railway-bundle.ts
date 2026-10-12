// Preserve the existing Railway Function image and runner, keeping source in Git.
// Inline handlers must retain their public names when browser code is minified.
const server = await Bun.file(
  new URL("../src/server.ts", import.meta.url),
).text();
let html = await Bun.file(
  new URL("../public/index.html", import.meta.url),
).text();
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!script) throw Error("Browser script was not found");
const handlers = [
  ...new Set(
    [
      ...script.matchAll(/\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g),
    ].map((m) => m[1]),
  ),
];
const browserSource = new URL(
  "../artifacts/browser-source.js",
  import.meta.url,
);
await Bun.write(
  browserSource,
  script + "\nObject.assign(globalThis,{" + handlers.join(",") + "});",
);
const browserBuild = await Bun.build({
  entrypoints: [browserSource.pathname],
  target: "browser",
  format: "iife",
  minify: true,
});
if (!browserBuild.success)
  throw Error(
    "Browser bundle failed: " + browserBuild.logs.map(String).join("; "),
  );
const browserCode = (await browserBuild.outputs[0].text()).replace(
  /<\/script/gi,
  "<\\/script",
);
html = html
  .replace(
    /<script>[\s\S]*?<\/script>/,
    () => "<script>" + browserCode + "</script>",
  )
  .replace(/>\s+</g, "><")
  .replace(/<style>([\s\S]*?)<\/style>/, (_, css) => "<style>" + css.replace(/\s+/g, " ").replace(/\s*([{}:;,])\s*/g, "$1").trim() + "</style>");
const pattern = /const html = await Bun\.file\([\s\S]*?\)\.text\(\);/;
if (!pattern.test(server)) throw Error("Frontend entry point was not found");
const intermediate = new URL(
  "../artifacts/function-source.ts",
  import.meta.url,
);
await Bun.write(
  intermediate,
  server.replace(pattern, () => "const html = " + JSON.stringify(html) + ";"),
);
const result = await Bun.build({
  entrypoints: [intermediate.pathname],
  target: "bun",
  minify: true,
  external: ["bun"],
});
if (!result.success)
  throw Error("Server bundle failed: " + result.logs.map(String).join("; "));
const uncompressed = await result.outputs[0].text();
await Bun.write(new URL("../artifacts/server-uncompressed.ts", import.meta.url), uncompressed);
const zipped = Buffer.from(Bun.gzipSync(new TextEncoder().encode(uncompressed))).toString("base64");
const code = `import {gunzipSync} from "node:zlib";await import("data:text/javascript;base64,"+gunzipSync(Buffer.from(${JSON.stringify(zipped)},"base64")).toString("base64"));`,
  command = "./run.sh " + Buffer.from(code).toString("base64");
if (command.length > 120000)
  throw Error("Railway startup command exceeds the safe argument size");
await Bun.write(new URL("../artifacts/server.ts", import.meta.url), code);
await Bun.write(
  new URL("../artifacts/railway-start-command.txt", import.meta.url),
  command,
);
console.log(
  "Railway Function bundle prepared (" +
    command.length +
    " bytes). No deployment performed.",
);
