const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const pkg = JSON.parse(fs.readFileSync("package.json", "utf-8"));
const manifest = fs.existsSync("manifest.json") ? JSON.parse(fs.readFileSync("manifest.json", "utf-8")) : {};
const name = manifest.name || pkg.name;
const revision = manifest.revision || 1;

fs.mkdirSync("dist", { recursive: true });
const outputFile = path.join("dist", `${name}-rev${revision}.tar.gz`);

// Ensure production build exists
execSync("npm run build", { stdio: "inherit" });

const filesToInclude = [
  "manifest.json",
  "package.json",
  "tsconfig.json",
  "README.md",
  ".gitignore",
  ".lmstudio",
  "src"
].filter(f => fs.existsSync(f));

const tarCmd = `tar -czf "${outputFile}" ${filesToInclude.join(" ")}`;
console.log(`Packaging extension into ${outputFile}...`);
execSync(tarCmd, { stdio: "inherit" });
console.log(`✓ Package created successfully: ${outputFile}`);
