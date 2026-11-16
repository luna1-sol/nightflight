import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";

const { version } = JSON.parse(readFileSync("package.json", "utf8")) as {
  version: string;
};

function buildId(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 8);
  try {
    return execSync("git rev-parse --short=8 HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "local";
  }
}

const CSP = /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]*)(")/;
const LABEL = /(<div\s+id="build-version"[^>]*>)[^<]*(<\/div>)/;
const INLINE: Record<string, string> = { "script-src": "script", "style-src": "style" };

function inlineHashes(tag: string, html: string): string[] {
  // Only inline blocks: <script src> and <link> are covered by 'self'.
  return [...html.matchAll(new RegExp(`<${tag}(?![^>]*\\ssrc=)[^>]*>([\\s\\S]*?)</${tag}>`, "g"))]
    .filter((match) => match[1].trim())
    .map(
      (match) => `'sha256-${createHash("sha256").update(match[1]).digest("base64")}'`,
    );
}

function stampCsp(html: string): string {
  return html.replace(CSP, (_, open: string, policy: string, close: string) => {
    const directives = policy
      .split(";")
      .map((directive) => directive.trim())
      .filter(Boolean)
      .map((directive) => {
        const [name, ...sources] = directive.split(/\s+/),
          tag = INLINE[name];
        if (!tag) return directive;
        const kept = sources.filter((source) => !source.startsWith("'sha256-"));
        return [name, ...kept, ...inlineHashes(tag, html)].join(" ");
      });
    return open + directives.join("; ") + close;
  });
}

/**
 * Stamps the version label and the Content-Security-Policy hashes of inline
 * <script>/<style> blocks into the built pages. During `vite dev` the policy
 * is dropped instead, because hot reload needs a websocket and inline styles.
 */
function releaseStamp(): Plugin {
  let outDir = "dist";
  const build = buildId();
  return {
    name: "nightflight-release-stamp",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    transformIndexHtml: {
      order: "post",
      handler(html, context) {
        if (context.server) return html.replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>\n?/, "");
        return html;
      },
    },
    closeBundle() {
      for (const file of readdirSync(outDir).filter((name) => name.endsWith(".html"))) {
        const target = path.join(outDir, file),
          mode = file === "offline.html" ? "offline" : "world",
          html = readFileSync(target, "utf8").replace(
            LABEL,
            `$1v${version} · ${build} · ${mode}$2`,
          );
        writeFileSync(target, stampCsp(html));
      }
    },
  };
}

export default defineConfig({
  // Relative URLs work at a domain root and under a subdirectory.
  base: "./",
  plugins: [releaseStamp()],
  worker: { format: "es" },
  build: {
    target: "es2022",
    sourcemap: false,
    // MapLibre itself is ~1.1 MB minified; that is expected.
    chunkSizeWarningLimit: 1200,
    rolldownOptions: {
      input: { main: "index.html", offline: "offline.html" },
      output: {
        // MapLibre changes only on upgrades, so it gets its own long-lived chunk.
        codeSplitting: {
          groups: [{ name: "maplibre", test: /node_modules[\\/]maplibre-gl/ }],
        },
      },
    },
  },
});
