# Database — SQL database in Fabric

Operational source of truth for the platform. Per **[ADR 0007](../docs/adr/0007-operational-datastore.md)**
this is a **SQL database in Fabric** (transactional OLTP, T-SQL / SQL Server engine), *not* the
Lakehouse SQL analytics endpoint and *not* Azure PostgreSQL (supersedes ADR 0001).

## Migrations

Versioned, forward + rollback (spec §18, docs/02). T-SQL.

| Version | Up | Down | Scope |
|---|---|---|---|
| 0001 | `migrations/0001_init.up.sql` | `migrations/0001_init.down.sql` | Operational baseline: ingestion → order → validation → **atomic duplicate claim** + audit |

Deferred to later migrations: outbox / integration-ack / processing-job tables (Phase 5) and the
learning entities (§10, Phase 6).

## The atomic duplicate claim (invariant #2)

Enforced by a **filtered unique index** in 0001:

```sql
CREATE UNIQUE INDEX UX_duplicate_claim_active
    ON dbo.duplicate_claim (business_key)
    WHERE status IN ('CLAIMED','RESOLVED');
```

`business_key = company_id :: erp_customer_account :: normalized_po_number`. Under concurrent
cross-channel arrivals exactly one `INSERT` wins; a `RELEASED` claim frees the key. The Phase-3
acceptance test must prove this under real concurrency on Fabric SQL (ADR 0007 follow-up #2).

## Applying (how, once a dev Fabric SQL database exists)

The DDL is plain T-SQL, apply with `sqlcmd` (or the Fabric SQL query editor / CI step):

```bash
sqlcmd -S "<fabric-sql-endpoint>" -d "<database>" -G -i db/migrations/0001_init.up.sql
# rollback:
sqlcmd -S "<fabric-sql-endpoint>" -d "<database>" -G -i db/migrations/0001_init.down.sql
```

`-G` uses Entra (managed identity / interactive) auth — no SQL logins (spec §3 least-privilege).

> ⚠️ No production database is created or migrated during development (spec §18). Dev/test Fabric SQL
> databases only, provisioned via `infra/terraform` (a `modules/fabric-sqldb` module — Phase 1).

## Type conventions (from PostgreSQL → SQL database in Fabric)

| Concept | Postgres (old ADR 0001) | SQL database in Fabric |
|---|---|---|
| UUID PK | `uuid DEFAULT gen_random_uuid()` | `uniqueidentifier DEFAULT NEWID()` |
| JSON column | `jsonb` | `nvarchar(max)` + `CHECK (ISJSON(col)=1)` |
| UTC timestamp | `timestamptz` | `datetime2(3) DEFAULT SYSUTCDATETIME()` |
| Partial unique index | `... WHERE status IN (...)` | filtered `CREATE UNIQUE INDEX ... WHERE ...` |
| Optimistic lock | `row_version int` | `row_version int` (unchanged) |
