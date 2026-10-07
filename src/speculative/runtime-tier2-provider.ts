import { createHash } from "node:crypto";

const TIER2_PROVIDER_NAME = "tier2:cow";

export const TIER2_PROVIDER_DIGEST = createHash("sha256")
	.update(TIER2_PROVIDER_NAME)
	.digest("hex");
