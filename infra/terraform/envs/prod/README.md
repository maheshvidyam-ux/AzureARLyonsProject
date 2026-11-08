# prod environment (stub)

Reuses `../../modules/*` with production-hardened inputs: Premium Service Bus, ACR Premium + private
endpoints, Key Vault purge protection, Blob ZRS/GRS + immutability, a larger Fabric SKU with a
**no-pause/reserved capacity policy** (ADR 0007 follow-up #1), HA, and private endpoints throughout.

Gated on: Q-ENV-1 hosting/security standards, the ADR 0007 availability-coupling mitigation, and a
validated dev → test promotion. No production mailbox or AX writes are configured here until those are
signed off (spec §18). See `../../README.md` for the environment matrix.
