/**
 * Live Model Catalog Loader for Entry Desktop V1
 *
 * CRITICAL REQUIREMENT (Section 3):
 * - Fetch real models from the Entry backend (`/api/desktop/models` & `/api/models`).
 * - Do NOT hardcode model names or model availability.
 * - Do NOT implement automatic model routing.
 * - Handle unavailable models, insufficient credits, authentication expiration, and network failures.
 */

const FALLBACK_ORIGINS = [
  "https://entry-agents.dev",
  "https://entry-project-b.vercel.app",
  "https://entry-desktop-backend.vercel.app",
];

export interface LiveDesktopModel {
  id: string;
  name: string;
  chef: string;
  chefSlug: string;
  providers: string[];
  contextWindow?: number;
  maxOutputTokens?: number;
  defaultReasoningEffort?: string;
}

export interface LiveModelsCatalogResponse {
  models: LiveDesktopModel[];
  freePlanModelId?: string | null;
  userPlan?: { id: string; modelAccess: string } | null;
  creditGate?: {
    blocked: boolean;
    reason: string | null;
    kind: string | null;
  } | null;
  authExpired?: boolean;
  sourceUrl: string;
}

export async function fetchLiveEntryModels(options: {
  baseUrl: string;
  sessionToken?: string | null;
}): Promise<LiveModelsCatalogResponse> {
  const primary = options.baseUrl.replace(/\/$/, "");
  const origins = new Set<string>([primary]);
  if (primary === "https://entry-agents.dev") {
    for (const fb of FALLBACK_ORIGINS) {
      origins.add(fb);
    }
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (options.sessionToken) {
    headers.Authorization = `Bearer ${options.sessionToken}`;
  }

  let lastStatus = 0;
  let authExpired = false;

  for (const base of origins) {
    const urls = options.sessionToken
      ? [`${base}/api/desktop/models`, `${base}/api/models`]
      : [`${base}/api/models`, `${base}/api/desktop/models`];

    for (const url of urls) {
      try {
        const res = await fetch(url, {
          method: "GET",
          headers,
        });
        lastStatus = res.status;
        if (res.status === 401 && url.endsWith("/api/desktop/models")) {
          authExpired = true;
          continue;
        }
        if (!res.ok) continue;

        const data = (await res.json()) as {
          models?: unknown[];
          data?: unknown[];
          freePlanModelId?: string | null;
          userPlan?: { id: string; modelAccess: string } | null;
          creditGate?: {
            blocked: boolean;
            reason: string | null;
            kind: string | null;
          } | null;
        };

        const rawList = Array.isArray(data.models)
          ? data.models
          : Array.isArray(data.data)
            ? data.data
            : [];

        const models: LiveDesktopModel[] = rawList
          .filter((item): item is Record<string, unknown> =>
            Boolean(item && typeof item === "object"),
          )
          .map((item) => {
            const id = String(item.id ?? "");
            const providerPrefix = id.includes("/")
              ? id.split("/")[0]
              : "entry";
            return {
              id,
              name: String(item.name ?? id),
              chef: String(item.chef ?? providerPrefix),
              chefSlug: String(item.chefSlug ?? providerPrefix.toLowerCase()),
              providers: Array.isArray(item.providers)
                ? item.providers.map(String)
                : [providerPrefix],
              contextWindow:
                typeof item.contextWindow === "number"
                  ? item.contextWindow
                  : undefined,
              maxOutputTokens:
                typeof item.maxOutputTokens === "number"
                  ? item.maxOutputTokens
                  : undefined,
              defaultReasoningEffort:
                typeof item.defaultReasoningEffort === "string"
                  ? item.defaultReasoningEffort
                  : undefined,
            };
          })
          .filter((m) => m.id.length > 0);

        if (models.length === 0) {
          continue;
        }

        return {
          models,
          freePlanModelId: data.freePlanModelId ?? null,
          userPlan: data.userPlan ?? null,
          creditGate: data.creditGate ?? null,
          authExpired,
          sourceUrl: url,
        };
      } catch {
        // try next url
      }
    }
  }

  throw new Error(
    authExpired
      ? "Authentication session expired (HTTP 401). Please sign in again."
      : `Unable to fetch live models from Entry backend (last HTTP status: ${lastStatus || "unreachable"})`,
  );
}
