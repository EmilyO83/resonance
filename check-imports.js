// Guards against the crash-on-launch class of bug.
//
// Metro's bundler only checks that a module RESOLVES, not that the names you
// import actually exist as runtime values. Importing a TYPE-only export (e.g.
// expo-audio's `AudioPlayer`) throws at module load and kills the app on the
// splash screen, with a clean bundle and no warning.
//
// This reads each import in our source files and verifies the name is a real
// runtime export of the package's built JS.
//
//   node check-imports.js
//
const fs = require('fs');
const path = require('path');

const FILES = ['App.js', 'index.js', 'toneEngine.js']
  .filter((f) => fs.existsSync(path.join(__dirname, f)));
let failures = 0;

// packages we can statically inspect (built to ESM in node_modules/<pkg>/build)
const CHECKABLE = ['expo-audio', 'expo-keep-awake'];

function runtimeExportsOf(pkg) {
  // Packages differ: some ship compiled JS in build/, others (e.g.
  // expo-keep-awake) ship TypeScript source and build/ holds only .d.ts.
  // Scan whichever directory actually contains runtime code.
  const root = path.join(__dirname, 'node_modules', pkg);
  const buildDir = path.join(root, 'build');
  const srcDir = path.join(root, 'src');
  const hasBuiltJs = fs.existsSync(buildDir) &&
    fs.readdirSync(buildDir).some((f) => f.endsWith('.js'));
  const dir = hasBuiltJs ? buildDir : (fs.existsSync(srcDir) ? srcDir : null);
  if (!dir) return null;

  const names = new Set();
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isDirectory()) { walk(p); continue; }
      const isCode = f.endsWith('.js') || (f.endsWith('.ts') && !f.endsWith('.d.ts'));
      if (!isCode || f.endsWith('.map')) continue;
      const src = fs.readFileSync(p, 'utf8');
      // export declarations that produce a RUNTIME binding
      const re = /export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/g;
      let m;
      while ((m = re.exec(src))) names.add(m[1]);
      // re-exported named bindings: export { a, b as c }
      // NOTE: must skip `export type { ... }` — those are type-only and have
      // no runtime value (this is exactly the bug this script exists to catch).
      const re2 = /export\s+(type\s+)?\{([^}]*)\}/g;
      while ((m = re2.exec(src))) {
        if (m[1]) continue;               // `export type { ... }` -> not runtime
        m[2].split(',').forEach((part) => {
          const t = part.trim();
          if (!t || /^type\s/.test(t)) return;  // inline `type X` specifier
          const bits = t.split(/\s+as\s+/);
          const name = (bits[1] || bits[0] || '').trim();
          if (name) names.add(name);
        });
      }
    }
  };
  walk(dir);
  return names;
}

for (const file of FILES) {
  const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const importRe = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = importRe.exec(src))) {
    const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    const pkg = m[2];
    if (!CHECKABLE.includes(pkg)) continue;
    const exported = runtimeExportsOf(pkg);
    if (!exported) { console.log(`? ${pkg}: no build dir, skipped`); continue; }
    for (const n of names) {
      if (!exported.has(n)) {
        console.log(`FAIL  ${file}: "${n}" is NOT a runtime export of ${pkg} (type-only or missing) -> CRASHES ON LAUNCH`);
        failures++;
      } else {
        console.log(`ok    ${file}: ${n} <- ${pkg}`);
      }
    }
  }
}

console.log(failures === 0 ? '\nAll checked imports are real runtime values.' : `\n${failures} bad import(s) would crash the app.`);
process.exit(failures === 0 ? 0 : 1);
