/**
 * LTV normalization constant — single source of truth shared by the feature
 * pipeline (@arbiter/ml) and the EV engine (@arbiter/core) so the two never
 * drift (bug #44: "two scales for the same concept").
 *
 * Realistic high-value LTV for a recurring SaaS/B2C book is ~₹25,000
 * (200 prior successes at a ~₹125 avg ticket). Below this the LTV weight
 * scales smoothly in [0.2, 1.5]; at/above it the weight saturates at 1.5.
 */
export const LTV_NORM_PAISE = 25_00_000;
