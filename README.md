# GNA Portalı

Recovered from the active `gna-web` Railway Function deployment on 2026-10-12. This is the existing GNA application, not a replacement application.

Scope: `timetechin/gna-portal` only. Do not modify `timetechin/tekinler-vdm-hesap` or deploy to VDM services.

Runtime: Bun 1.4+, PostgreSQL. No third-party server dependencies. Existing tables and user/password/session conventions are preserved.

Copy `.env.example` to `.env` for local development, set a password for the first administrator only if the development database is empty, then run `bun run dev`. Never use the production database for tests. `bun test` uses `GNA_TEST_DATABASE_URL` and rejects non-loopback databases.

Each cloud task already runs in isolation. Use the existing checkout; do not create a Git worktree unless explicitly requested.

The production service uses `ghcr.io/railwayapp/function-bun:1.4.0` and `./run.sh` with inline source. `bun run railway:bundle` prepares the same format without deploying. The generated artifact contains source only, no credentials. Publication requires a verified GNA database backup, passing tests, and explicit service/environment IDs. Do not overwrite Railway variables or change the existing database connection.
