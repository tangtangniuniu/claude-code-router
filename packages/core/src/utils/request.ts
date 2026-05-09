import { ProxyAgent } from "undici";
import { LLMProvider, UnifiedChatRequest } from "../types/llm";

// Resolve which proxy URL (if any) should be used for a given provider request.
// Provider-level `proxy` overrides the global proxy:
//   - string with content → use that URL
//   - explicit false or empty string → bypass proxy (direct connection)
//   - undefined → fall back to the global proxy
export function resolveProviderProxy(
  provider: Pick<LLMProvider, "proxy"> | undefined | null,
  globalProxy: string | undefined
): string | undefined {
  const providerProxy = provider?.proxy;
  if (providerProxy === false) return undefined;
  if (typeof providerProxy === "string") {
    return providerProxy.trim() === "" ? undefined : providerProxy;
  }
  return globalProxy;
}

export function sendUnifiedRequest(
  url: URL | string,
  request: UnifiedChatRequest,
  config: any,
  context: any,
  logger?: any
): Promise<Response> {
  const headers = new Headers({
    "Content-Type": "application/json",
  });
  if (config.headers) {
    Object.entries(config.headers).forEach(([key, value]) => {
      if (value) {
        headers.set(key, value as string);
      }
    });
  }
  let combinedSignal: AbortSignal;
  const timeoutSignal = AbortSignal.timeout(config.TIMEOUT ?? 60 * 1000 * 60);

  if (config.signal) {
    const controller = new AbortController();
    const abortHandler = () => controller.abort();
    config.signal.addEventListener("abort", abortHandler);
    timeoutSignal.addEventListener("abort", abortHandler);
    combinedSignal = controller.signal;
  } else {
    combinedSignal = timeoutSignal;
  }

  const fetchOptions: RequestInit = {
    method: "POST",
    headers: headers,
    body: JSON.stringify(request),
    signal: combinedSignal,
  };

  if (config.httpsProxy) {
    (fetchOptions as any).dispatcher = new ProxyAgent(
      new URL(config.httpsProxy).toString()
    );
  }
  logger?.debug(
    {
      reqId: context.req.id,
      request: fetchOptions,
      headers: Object.fromEntries(headers.entries()),
      requestUrl: typeof url === "string" ? url : url.toString(),
      useProxy: config.httpsProxy,
    },
    "final request"
  );
  return fetch(typeof url === "string" ? url : url.toString(), fetchOptions);
}
