/**
 * The chat endpoint of a Local LLM configuration's base URL (vscimpb68).
 *
 * A base URL **without a path** (`http://localhost:11434`, a trailing `/`
 * alone) is the server's root: the endpoint is the API style's well-known
 * absolute path — `/api/chat` (Ollama) or `/v1/chat/completions`
 * (OpenAI-compatible: vLLM, LM Studio, llama.cpp).
 *
 * A base URL **with a path** is the API root, and the endpoint is appended to
 * it, keeping that path: `https://qianfan.baidubce.com/v2` →
 * `…/v2/chat/completions`, `https://host/v1beta/openai/` →
 * `…/v1beta/openai/chat/completions`, an Ollama behind a proxy at
 * `https://gw/ollama` → `…/ollama/api/chat`. `http://host:8000/v1` gives
 * `/v1/chat/completions`, as before. A query on such a base (an
 * `api-version`, say) is kept; a fragment is dropped. The request goes over
 * TLS when the base is `https:` (the handler picks `https.request`).
 *
 * Earlier the endpoint was joined with `new URL('/v1/chat/completions', base)`,
 * whose absolute path replaced the base's own path.
 */

/** The wire protocol of a Local LLM configuration. */
export type LocalLlmEndpointStyle = 'ollama' | 'openai';

/** The endpoint's absolute path on a base URL without a path. */
const ROOT_PATH: Record<LocalLlmEndpointStyle, string> = { ollama: '/api/chat', openai: '/v1/chat/completions' };
/** The endpoint's path relative to an API root. */
const RELATIVE_PATH: Record<LocalLlmEndpointStyle, string> = { ollama: 'api/chat', openai: 'chat/completions' };

/** The chat endpoint for `baseUrl` and `apiStyle`. Throws on a base that is not a URL. */
export function localLlmChatUrl(baseUrl: string, apiStyle: LocalLlmEndpointStyle): URL {
    const base = new URL(baseUrl.trim());
    const root = base.pathname.replace(/\/+$/, '');
    if (root === '') {
        return new URL(ROOT_PATH[apiStyle], base);
    }
    const url = new URL(base.toString());
    url.pathname = `${root}/${RELATIVE_PATH[apiStyle]}`;
    url.hash = '';
    return url;
}

/** The request path for `http.request` / `https.request`: the path with its query. */
export function localLlmRequestPath(url: URL): string {
    return `${url.pathname}${url.search}`;
}

/** The endpoint as text for logs and the request dump; the base URL itself when it is not a URL. */
export function localLlmEndpointText(baseUrl: string, apiStyle: LocalLlmEndpointStyle): string {
    try {
        return localLlmChatUrl(baseUrl, apiStyle).toString();
    } catch {
        return `${baseUrl} (not a URL)`;
    }
}
