import { dirname, resolve as absPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import type { Plugin, UserConfig } from 'vite';

const lucideSubsetEntry = absPath(
  dirname(fileURLToPath(import.meta.url)),
  'src/renderer/components/lucideIcons.ts',
);

/** Exact package name only — do not alias `lucide-react/dist/...` icon files. */
export function lucideReactAlias(): { find: RegExp; replacement: string } {
  return { find: /^lucide-react$/, replacement: lucideSubsetEntry };
}

/**
 * Shared renderer Vite options: compact transforms in `vite serve`
 * (Lighthouse against localhost still sees HMR), and a minified
 * production bundle without source maps.
 *
 * Do not import `esbuild` here — electron-vite loads this file as ESM
 * and esbuild is only a nested Vite dependency, so a direct import
 * fails config load with ERR_MODULE_NOT_FOUND.
 *
 * `lucide-react` is aliased to a subset barrel so optimizeDeps does not
 * prebundle the full icon set (~4.5 MiB) onto the first-paint chain.
 */
export function rendererOptimize(): Pick<
  UserConfig,
  'esbuild' | 'css' | 'build' | 'optimizeDeps' | 'plugins' | 'server' | 'resolve'
> {
  return {
    esbuild: {
      legalComments: 'none',
      minifyIdentifiers: false,
      minifySyntax: true,
      minifyWhitespace: true,
    },
    css: { devSourcemap: false },
    optimizeDeps: {
      include: [
        'react',
        'react-dom',
        'react-dom/client',
        'react-router-dom',
        'i18next',
        'react-i18next',
        'zustand',
        'lucide-react',
      ],
      esbuildOptions: {
        minify: true,
        sourcemap: false,
        legalComments: 'none',
        treeShaking: true,
      },
    },
    resolve: {
      alias: [lucideReactAlias()],
    },
    server: {
      warmup: {
        clientFiles: [
          './main.tsx',
          './routes.tsx',
          './app/AppLayout.tsx',
          './app/pages/LoginPage.tsx',
          './app/pages/TablesPage.tsx',
        ],
      },
    },
    build: {
      minify: 'esbuild',
      cssMinify: true,
      sourcemap: false,
      target: 'es2020',
      modulePreload: { polyfill: false },
      reportCompressedSize: false,
    },
    plugins: [
      aliasLucideSubset(),
      gzipHtmlDocument(),
      preloadCriticalModules(),
    ],
  };
}

export function shouldGzipHtmlDocument(input: {
  method?: string;
  url?: string;
  acceptEncoding?: string;
  upgrade?: string;
}): boolean {
  if (input.upgrade) return false;
  const method = String(input.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (!String(input.acceptEncoding || '').includes('gzip')) return false;
  const path = String(input.url || '').split('?')[0];
  return path === '/' || path === '/index.html' || path.endsWith('/index.html');
}

const NO_BODY_STATUSES = new Set([304, 204, 205]);

/** Drop validators so Vite cannot 304 the HTML document into a blank window. */
export function stripConditionalGetHeaders(
  headers: Record<string, unknown> | undefined,
): void {
  if (!headers) return;
  delete headers['if-none-match'];
  delete headers['if-modified-since'];
}

export function planGzipHtmlBody(input: {
  statusCode?: number;
  body: Buffer;
}): {
  statusCode: number;
  body: Buffer;
  contentEncoding?: 'gzip';
  setContentLength: boolean;
} {
  const statusCode = input.statusCode || 200;
  // Vite's ETag 304 is `res.statusCode = 304; res.end()` with no writeHead.
  // Rewriting that as 200 + empty body is what blanks every other Cmd+R.
  if (NO_BODY_STATUSES.has(statusCode)) {
    return {
      statusCode,
      body: Buffer.alloc(0),
      setContentLength: false,
    };
  }
  if (input.body.length < 32) {
    return { statusCode, body: input.body, setContentLength: true };
  }
  return {
    statusCode,
    body: gzipSync(input.body),
    contentEncoding: 'gzip',
    setContentLength: true,
  };
}

/** Exact-package alias so `lucide-react/dist/...` icon files still resolve. */
function aliasLucideSubset(): Plugin {
  return {
    name: 'alias-lucide-subset',
    enforce: 'pre',
    config() {
      return {
        resolve: {
          alias: [{ find: /^lucide-react$/, replacement: lucideSubsetEntry }],
        },
      };
    },
  };
}

/** Gzip only the HTML document so Lighthouse sees Content-Encoding without wrapping HMR. */
function gzipHtmlDocument(): Plugin {
  return {
    name: 'gzip-html-document',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (
          !shouldGzipHtmlDocument({
            method: req.method,
            url: req.url,
            acceptEncoding: String(req.headers['accept-encoding'] || ''),
            upgrade: String(req.headers.upgrade || ''),
          })
        ) {
          next();
          return;
        }

        // Vite 304s index.html via ETag. Chrome with DevTools "Disable cache"
        // still sends If-None-Match, then refuses the cached body — and our
        // wrapper used to turn that 304 into 200 + empty HTML.
        stripConditionalGetHeaders(req.headers as Record<string, unknown>);

        const chunks: Buffer[] = [];
        const origEnd = res.end.bind(res);
        const origWriteHead = res.writeHead.bind(res);
        let status = res.statusCode || 200;

        const takeChunk = (chunk: unknown, encoding?: unknown) => {
          if (!chunk) return;
          chunks.push(
            Buffer.isBuffer(chunk)
              ? chunk
              : Buffer.from(
                  chunk as string,
                  typeof encoding === 'string'
                    ? (encoding as BufferEncoding)
                    : 'utf8',
                ),
          );
        };

        res.writeHead = ((code?: number, ...rest: unknown[]) => {
          if (typeof code === 'number') status = code;
          const headerBag =
            rest[0] && typeof rest[0] === 'object' && !Array.isArray(rest[0])
              ? rest[0]
              : rest[1] && typeof rest[1] === 'object' && !Array.isArray(rest[1])
                ? rest[1]
                : null;
          if (headerBag) {
            for (const [k, v] of Object.entries(
              headerBag as Record<string, string | number | string[]>,
            )) {
              if (v != null) res.setHeader(k, v as string);
            }
          }
          return res;
        }) as typeof res.writeHead;

        res.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
          takeChunk(chunk, encoding);
          if (typeof encoding === 'function') encoding();
          if (typeof cb === 'function') cb();
          return true;
        }) as typeof res.write;

        res.end = ((chunk?: unknown, encoding?: unknown, cb?: unknown) => {
          if (typeof chunk === 'function') {
            cb = chunk;
            chunk = undefined;
          } else if (typeof encoding === 'function') {
            cb = encoding;
            encoding = undefined;
          }
          takeChunk(chunk, encoding);
          const raw = chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
          const planned = planGzipHtmlBody({
            statusCode: res.statusCode || status,
            body: raw,
          });
          if (planned.contentEncoding) {
            res.setHeader('Content-Encoding', planned.contentEncoding);
            res.setHeader('Vary', 'Accept-Encoding');
          }
          if (planned.setContentLength) {
            res.setHeader('Content-Length', String(planned.body.length));
          }
          origWriteHead(planned.statusCode);
          if (planned.body.length) {
            if (typeof cb === 'function') return origEnd(planned.body, cb);
            return origEnd(planned.body);
          }
          if (typeof cb === 'function') return origEnd(cb);
          return origEnd();
        }) as typeof res.end;

        next();
      });
    },
  };
}

/** Start Vite HMR + entry fetch in parallel with HTML parse (shortens Lighthouse chains). */
function preloadCriticalModules(): Plugin {
  return {
    name: 'preload-critical-modules',
    apply: 'serve',
    transformIndexHtml() {
      return [
        {
          tag: 'link',
          attrs: { rel: 'modulepreload', href: '/@react-refresh' },
          injectTo: 'head',
        },
        {
          tag: 'link',
          attrs: { rel: 'modulepreload', href: '/@vite/client' },
          injectTo: 'head',
        },
        {
          tag: 'link',
          attrs: { rel: 'modulepreload', href: '/main.tsx' },
          injectTo: 'head',
        },
      ];
    },
  };
}
