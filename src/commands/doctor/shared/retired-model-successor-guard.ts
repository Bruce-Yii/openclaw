import type { createModelAuthAvailabilityResolver } from "../../../agents/model-auth-availability.js";
import { splitTrailingAuthProfile } from "../../../agents/model-ref-profile.js";
import { canonicalizeProviderModelId } from "../../../agents/provider-model-route.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { ManifestModelSuppressionResolver } from "../../../plugins/manifest-model-suppression.js";
import type { ModelRefRepair, ModelRetirementScope } from "./retired-model-ref-repair.js";

export type SuccessorGuardOwner = {
  suppression(config?: OpenClawConfig): ManifestModelSuppressionResolver;
  auth(profileId: string | undefined): ReturnType<typeof createModelAuthAvailabilityResolver>;
};

export function resolveSuccessorModelRepair(params: {
  owner: SuccessorGuardOwner;
  provider: string;
  canonical: string;
  agentId: string;
  modelRefInput: string;
  authProfileId?: string;
  authProfileSource?: SessionEntry["authProfileOverrideSource"];
  retirement: { replacedBy?: string };
  retirementScope: ModelRetirementScope;
  suppressionConfig?: OpenClawConfig;
  suppressionBaseUrl?: string;
  preserved: ModelRefRepair;
  validatePolicy: (repair: ModelRefRepair) => ModelRefRepair;
  warn: (message: string) => void;
}): ModelRefRepair {
  const { owner, provider, canonical, agentId } = params;
  const successor = params.retirement.replacedBy;
  if (!successor) {
    return {
      kind: "clear",
      provider,
      modelRef: canonical,
      retirementScope: params.retirementScope,
    };
  }
  // Validate the successor against the same owner context before migrating.
  // Writing an unsupported successor into selectors, fallbacks, and policy
  // allow lists converts a visible retirement warning into a latent unusable
  // reference (#156155). Missing evidence is not proof: only an explicitly
  // retired or authoritatively unavailable successor blocks the migration.
  const successorId = canonicalizeProviderModelId(provider, successor);
  const successorRule = params.suppressionConfig
    ? owner.suppression(params.suppressionConfig)({
        provider,
        id: successorId,
        baseUrl: params.suppressionBaseUrl,
      })
    : owner.suppression()({ provider, id: successorId, unconditionalOnly: true });
  if (successorRule?.retirement) {
    params.warn(
      `Retained ${canonical} for agent "${agentId}": successor "${provider}/${successor}" is retired. Choose a supported model explicitly and rerun openclaw doctor --fix.`,
    );
    return params.validatePolicy(params.preserved);
  }
  const parsed = splitTrailingAuthProfile(params.modelRefInput);
  const pinnedProfileId =
    (params.authProfileSource === "user" || params.authProfileSource === "user-link"
      ? params.authProfileId
      : undefined) ?? parsed.profile;
  const preferredProfileId = pinnedProfileId ? undefined : params.authProfileId;
  const support = owner
    .auth(pinnedProfileId ?? preferredProfileId)
    .evaluateRuntimeModelAuth(provider, {
      modelId: successorId,
      pinnedProfileId,
      preferredProfileId,
    });
  if (support.availability === false && support.availabilityAuthoritative) {
    params.warn(
      `Retained ${canonical} for agent "${agentId}": successor "${provider}/${successor}" is not supported by this agent's authentication route. Choose a supported model explicitly and rerun openclaw doctor --fix.`,
    );
    return params.validatePolicy(params.preserved);
  }
  const modelRef = `${provider}/${successor}`;
  return params.validatePolicy({
    kind: "replace",
    modelRef: parsed.profile ? `${modelRef}@${parsed.profile}` : modelRef,
    reason: "retirement",
    retirementScope: params.retirementScope,
  });
}
