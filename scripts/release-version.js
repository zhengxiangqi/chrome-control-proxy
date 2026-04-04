const fs = require('fs');
const path = require('path');

const releaseType = process.argv[2];
const allowedTypes = new Set(['patch', 'minor', 'major']);

if (!allowedTypes.has(releaseType)) {
  console.error('Usage: node scripts/release-version.js <patch|minor|major>');
  process.exit(1);
}

const rootDir = path.resolve(__dirname, '..');
const packageJsonPath = path.join(rootDir, 'package.json');
const skillPath = path.join(rootDir, 'chrome-control-proxy', 'SKILL.md');
const changelogPath = path.join(rootDir, 'CHANGELOG.md');

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function writeText(filePath, content) {
  fs.writeFileSync(filePath, content, 'utf8');
}

function bumpVersion(version, type) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`Unsupported version format: ${version}`);
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);

  if (type === 'major') {
    return `${major + 1}.0.0`;
  }
  if (type === 'minor') {
    return `${major}.${minor + 1}.0`;
  }
  return `${major}.${minor}.${patch + 1}`;
}

function updatePackageJson(nextVersion) {
  const pkg = JSON.parse(readText(packageJsonPath));
  const prevVersion = pkg.version;
  pkg.version = nextVersion;
  writeText(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
  return prevVersion;
}

function updateSkillVersion(nextVersion) {
  const skillText = readText(skillPath);
  const updated = skillText.replace(/^version:\s*.+$/m, `version: ${nextVersion}`);
  if (updated === skillText) {
    throw new Error('SKILL.md version not found');
  }
  writeText(skillPath, updated);
}

const currentVersion = JSON.parse(readText(packageJsonPath)).version;
const nextVersion = bumpVersion(currentVersion, releaseType);

updatePackageJson(nextVersion);
updateSkillVersion(nextVersion);

console.log(`Version bumped: ${currentVersion} -> ${nextVersion}`);
console.log(`Updated: ${path.relative(rootDir, packageJsonPath)}`);
console.log(`Updated: ${path.relative(rootDir, skillPath)}`);
console.log(`Reminder: review ${path.relative(rootDir, changelogPath)} and move Unreleased changes into ${nextVersion}`);
