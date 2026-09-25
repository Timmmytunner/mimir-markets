/**
 * Generate a CycloneDX 1.5 JSON SBOM from package-lock.json.
 *
 * Reproducible from a clean checkout — reads only the lockfile on disk.
 * No production secrets, network calls, or deployment credentials.
 *
 * Run: npm run sbom:release
 *      node scripts/generate-release-sbom.mjs [--lock <path>] [--out <path>] [--name <name>] [--version <ver>]
 *
 * Exit codes:
 *   0  SBOM written
 *   1  actionable failure (missing lock, unsupported lockfile, empty component set, I/O error)
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    lock: resolve(ROOT, "package-lock.json"),
    out: resolve(ROOT, "sbom", "mimir.cdx.json"),
    name: null,
    version: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--lock") out.lock = resolve(argv[++i]);
    else if (a === "--out") out.out = resolve(argv[++i]);
    else if (a === "--name") out.name = argv[++i];
    else if (a === "--version") out.version = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

/**
 * Build a CycloneDX 1.5 document from an npm lockfile v2/v3 object.
 * Fail-closed: throws with an actionable message when the lock cannot yield a usable SBOM.
 */
export function buildCycloneDxFromLockfile(lock, { name, version, serialNumber } = {}) {
  if (lock == null || typeof lock !== "object") {
    throw new Error("SBOM generation failed: lockfile JSON is missing or not an object");
  }
  const lockfileVersion = lock.lockfileVersion;
  if (lockfileVersion !== 2 && lockfileVersion !== 3) {
    throw new Error(
      `SBOM generation failed: unsupported lockfileVersion ${lockfileVersion} (need 2 or 3). Re-run npm install to refresh package-lock.json.`,
    );
  }
  const packages = lock.packages;
  if (!packages || typeof packages !== "object") {
    throw new Error("SBOM generation failed: lockfile has no packages map (corrupt or incomplete package-lock.json)");
  }

  const rootMeta = packages[""] || {};
  const rootName = name || lock.name || rootMeta.name || "mimir";
  const rootVersion = version || lock.version || rootMeta.version || "0.0.0";

  const components = [];
  const seen = new Set();

  for (const [pkgPath, meta] of Object.entries(packages)) {
    if (!pkgPath || pkgPath === "") continue; // skip root
    if (!meta || typeof meta !== "object") continue;
    // Skip link / workspace stubs without a version
    if (meta.link === true && !meta.version) continue;

    const pkgName = meta.name || deriveNameFromPath(pkgPath);
    const pkgVersion = meta.version;
    if (!pkgName || !pkgVersion) {
      // Optional deps / bundled placeholders — skip quietly but never invent versions
      continue;
    }

    const purl = `pkg:npm/${encodePurlName(pkgName)}@${encodeURIComponent(pkgVersion)}`;
    if (seen.has(purl)) continue;
    seen.add(purl);

    const component = {
      type: "library",
      "bom-ref": purl,
      name: pkgName,
      version: pkgVersion,
      purl,
      scope: meta.dev === true ? "optional" : "required",
    };

    if (meta.license) {
      component.licenses = normalizeLicenses(meta.license);
    }
    if (meta.integrity) {
      component.hashes = [integrityToHash(meta.integrity)].filter(Boolean);
      if (component.hashes.length === 0) delete component.hashes;
    }
    if (meta.resolved) {
      component.externalReferences = [
        { type: "distribution", url: String(meta.resolved) },
      ];
    }

    components.push(component);
  }

  components.sort((a, b) => (a.purl < b.purl ? -1 : a.purl > b.purl ? 1 : 0));

  if (components.length === 0) {
    throw new Error(
      "SBOM generation failed: zero package components found in lockfile. Refusing to publish an empty SBOM (fail-closed).",
    );
  }

  const serial =
    serialNumber ||
    `urn:uuid:${deterministicUuid(`${rootName}@${rootVersion}:${components.length}:${components[0].purl}`)}`;

  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: serial,
    version: 1,
    metadata: {
      timestamp: "1970-01-01T00:00:00Z", // overwritten by stampMetadata unless frozen for tests
      tools: {
        components: [
          {
            type: "application",
            name: "generate-release-sbom",
            version: "1.0.0",
          },
        ],
      },
      component: {
        type: "application",
        name: rootName,
        version: rootVersion,
        "bom-ref": `pkg:npm/${encodePurlName(rootName)}@${encodeURIComponent(rootVersion)}`,
        purl: `pkg:npm/${encodePurlName(rootName)}@${encodeURIComponent(rootVersion)}`,
      },
    },
    components,
  };
}

export function stampMetadata(bom, { timestamp } = {}) {
  bom.metadata.timestamp = timestamp || new Date().toISOString();
  return bom;
}

export function loadLockfile(lockPath) {
  let raw;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (err) {
    throw new Error(
      `SBOM generation failed: cannot read lockfile at ${lockPath} (${err.code || err.message}). Ensure package-lock.json is present in a clean checkout.`,
    );
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `SBOM generation failed: lockfile at ${lockPath} is not valid JSON (${err.message}).`,
    );
  }
}

export function writeSbom(bom, outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(bom, null, 2)}\n`, "utf8");
}

function deriveNameFromPath(pkgPath) {
  // node_modules/@scope/name or node_modules/name (last segment after node_modules)
  const marker = "node_modules/";
  const idx = pkgPath.lastIndexOf(marker);
  if (idx === -1) return pkgPath;
  return pkgPath.slice(idx + marker.length);
}

function encodePurlName(name) {
  // CycloneDX/purl: scoped packages are @scope/name → %40scope/name
  if (name.startsWith("@")) {
    const [scope, pkg] = name.slice(1).split("/", 2);
    return `${encodeURIComponent(`@${scope}`)}/${encodeURIComponent(pkg || "")}`;
  }
  return encodeURIComponent(name);
}

function normalizeLicenses(license) {
  if (Array.isArray(license)) {
    return license.flatMap((l) => normalizeLicenses(l));
  }
  if (typeof license === "object" && license.type) {
    return [{ license: { id: String(license.type) } }];
  }
  return [{ license: { id: String(license) } }];
}

function integrityToHash(integrity) {
  // e.g. sha512-abc...
  const m = String(integrity).match(/^(sha256|sha384|sha512)-([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  const alg = m[1].replace("sha", "SHA-");
  // Convert base64 digest to hex for CycloneDX
  const hex = Buffer.from(m[2], "base64").toString("hex");
  return { alg, content: hex };
}

/** Deterministic UUID v5-ish from a string (for stable serialNumbers in tests). */
function deterministicUuid(input) {
  const hash = Buffer.from(
    // simple FNV-ish expansion via crypto not required for uniqueness in tests
    [...Array(16)].map((_, i) => {
      let h = 2166136261;
      for (let j = 0; j < input.length; j++) {
        h ^= input.charCodeAt(j) + i;
        h = Math.imul(h, 16777619);
      }
      return (h >>> 0) % 256;
    }),
  );
  hash[6] = (hash[6] & 0x0f) | 0x40;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(
      "Usage: node scripts/generate-release-sbom.mjs [--lock path] [--out path] [--name name] [--version ver]",
    );
    return 0;
  }
  const lock = loadLockfile(args.lock);
  const bom = stampMetadata(
    buildCycloneDxFromLockfile(lock, { name: args.name, version: args.version }),
  );
  writeSbom(bom, args.out);
  console.log(
    `✓ wrote CycloneDX SBOM (${bom.components.length} components) → ${args.out}`,
  );
  return 0;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }
}
