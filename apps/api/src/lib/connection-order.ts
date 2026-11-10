// Which of an org's connections to a provider a job should use when it has
// more than one: a verified one first, then one never checked, and an invalid
// one only as a last resort, newest first within each. Status is a string, so
// this relies on "valid" > "unverified" > "invalid" sorting descending; the
// test pins that, since a new status value could silently break it.
export const BY_STATUS = { status: "desc" as const };
export const BY_NEWEST = { createdAt: "desc" as const };
export const PREFER_USABLE_CONNECTION = [BY_STATUS, BY_NEWEST];
